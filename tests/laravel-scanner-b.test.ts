import { describe, it, expect } from 'vitest'
import { extractFromSource } from '../src/graphs/extractor'
import { parsePhpFile } from '../src/graphs/php-parser'
import {
  scanJobs,
  scanEventsAndListeners,
  scanObservers,
  type LaravelScannerContext,
} from '../src/graphs/laravel-scanner'
import type { GraphNode, GraphEdge } from '../src/graphs/schema'

function buildContext(extractions: Array<{ source: string; filePath: string }>): LaravelScannerContext {
  const allNodes = new Map<string, GraphNode>()
  const allEdges: GraphEdge[] = []
  const edgeSet = new Set<string>()
  const astCache = new Map<string, { ast: any; filePath: string; namespace: string; useMap: Map<string, string> }>()
  const fqcnIndex = new Map<string, string>()

  for (const { source, filePath } of extractions) {
    const result = extractFromSource(source, filePath)
    for (const n of result.nodes) allNodes.set(n.key, n)
    for (const e of result.edges) {
      const sig = `${e.from}|${e.to}|${e.kind}`
      if (!edgeSet.has(sig)) { edgeSet.add(sig); allEdges.push(e) }
    }
    const parsed = parsePhpFile(source)
    astCache.set(filePath, { ast: parsed.ast, filePath, namespace: result.namespace, useMap: result.useMap })
    for (const sym of result.declaredSymbols) fqcnIndex.set(sym, filePath)
  }

  return { nodes: allNodes, edges: allEdges, edgeSet, astCache, fqcnIndex }
}

function edgeExists(ctx: LaravelScannerContext, from: string, to: string, kind: string): boolean {
  return ctx.edges.some(e => e.from === from && e.to === to && e.kind === kind)
}

function nodeExists(ctx: LaravelScannerContext, key: string): boolean {
  return ctx.nodes.has(key)
}

// ── scanJobs ──

const JOB_DISPATCH_CONTROLLER = `<?php
namespace App\\Http\\Controllers;

use App\\Jobs\\ProcessCheckout;
use App\\Jobs\\SendNotification;

class CheckoutController extends Controller
{
    public function store()
    {
        ProcessCheckout::dispatch();
        dispatch(new SendNotification());
    }
}
`

const JOB_DISPATCH_SERVICE = `<?php
namespace App\\Services;

use App\\Jobs\\SyncInventory;

class InventoryService
{
    public function sync(): void
    {
        SyncInventory::dispatch();
    }
}
`

describe('scanJobs — controller dispatches', () => {
  it('creates controller_dispatches_job for Job::dispatch() in controller', () => {
    const ctx = buildContext([
      { source: JOB_DISPATCH_CONTROLLER, filePath: 'src/Http/Controllers/CheckoutController.php' },
    ])
    scanJobs(ctx)

    expect(nodeExists(ctx, 'job:App\\Jobs\\ProcessCheckout')).toBe(true)
    expect(edgeExists(ctx,
      'method:App\\Http\\Controllers\\CheckoutController::store',
      'job:App\\Jobs\\ProcessCheckout',
      'controller_dispatches_job',
    )).toBe(true)
  })

  it('creates controller_dispatches_job for dispatch(new Job()) in controller', () => {
    const ctx = buildContext([
      { source: JOB_DISPATCH_CONTROLLER, filePath: 'src/Http/Controllers/CheckoutController.php' },
    ])
    scanJobs(ctx)

    expect(nodeExists(ctx, 'job:App\\Jobs\\SendNotification')).toBe(true)
    expect(edgeExists(ctx,
      'method:App\\Http\\Controllers\\CheckoutController::store',
      'job:App\\Jobs\\SendNotification',
      'controller_dispatches_job',
    )).toBe(true)
  })
})

describe('scanJobs — non-controller dispatches', () => {
  it('creates dispatches_job for Job::dispatch() in service', () => {
    const ctx = buildContext([
      { source: JOB_DISPATCH_SERVICE, filePath: 'src/Services/InventoryService.php' },
    ])
    scanJobs(ctx)

    expect(nodeExists(ctx, 'job:App\\Jobs\\SyncInventory')).toBe(true)
    expect(edgeExists(ctx,
      'method:App\\Services\\InventoryService::sync',
      'job:App\\Jobs\\SyncInventory',
      'dispatches_job',
    )).toBe(true)
  })
})

// ── scanEventsAndListeners ──

const EVENT_SERVICE_PROVIDER = `<?php
namespace App\\Providers;

use Illuminate\\Foundation\\Support\\Providers\\EventServiceProvider as ServiceProvider;
use App\\Events\\OrderCreated;
use App\\Events\\OrderShipped;
use App\\Listeners\\SendOrderConfirmation;
use App\\Listeners\\UpdateInventory;
use App\\Listeners\\NotifyWarehouse;

class EventServiceProvider extends ServiceProvider
{
    protected $listen = [
        OrderCreated::class => [
            SendOrderConfirmation::class,
            UpdateInventory::class,
        ],
        OrderShipped::class => [
            NotifyWarehouse::class,
        ],
    ];
}
`

const EVENT_EMISSION = `<?php
namespace App\\Services;

use App\\Events\\OrderCreated;

class OrderService
{
    public function create(): void
    {
        event(new OrderCreated());
    }
}
`

describe('scanEventsAndListeners — $listen map', () => {
  it('creates event and listener nodes from $listen property', () => {
    const ctx = buildContext([
      { source: EVENT_SERVICE_PROVIDER, filePath: 'src/Providers/EventServiceProvider.php' },
    ])
    scanEventsAndListeners(ctx)

    expect(nodeExists(ctx, 'event:App\\Events\\OrderCreated')).toBe(true)
    expect(nodeExists(ctx, 'event:App\\Events\\OrderShipped')).toBe(true)
    expect(nodeExists(ctx, 'listener:App\\Listeners\\SendOrderConfirmation')).toBe(true)
    expect(nodeExists(ctx, 'listener:App\\Listeners\\UpdateInventory')).toBe(true)
    expect(nodeExists(ctx, 'listener:App\\Listeners\\NotifyWarehouse')).toBe(true)
  })

  it('creates listens_to_event edges', () => {
    const ctx = buildContext([
      { source: EVENT_SERVICE_PROVIDER, filePath: 'src/Providers/EventServiceProvider.php' },
    ])
    scanEventsAndListeners(ctx)

    expect(edgeExists(ctx,
      'listener:App\\Listeners\\SendOrderConfirmation',
      'event:App\\Events\\OrderCreated',
      'listens_to_event',
    )).toBe(true)
    expect(edgeExists(ctx,
      'listener:App\\Listeners\\UpdateInventory',
      'event:App\\Events\\OrderCreated',
      'listens_to_event',
    )).toBe(true)
    expect(edgeExists(ctx,
      'listener:App\\Listeners\\NotifyWarehouse',
      'event:App\\Events\\OrderShipped',
      'listens_to_event',
    )).toBe(true)
  })
})

describe('scanEventsAndListeners — event emission', () => {
  it('creates emits_event edge for event(new X())', () => {
    const ctx = buildContext([
      { source: EVENT_EMISSION, filePath: 'src/Services/OrderService.php' },
    ])
    scanEventsAndListeners(ctx)

    expect(edgeExists(ctx,
      'method:App\\Services\\OrderService::create',
      'event:App\\Events\\OrderCreated',
      'emits_event',
    )).toBe(true)
  })
})

// ── scanObservers ──

const OBSERVER_PROVIDER = `<?php
namespace App\\Providers;

use Illuminate\\Support\\ServiceProvider;
use App\\Models\\Order;
use App\\Models\\Product;
use App\\Observers\\OrderObserver;
use App\\Observers\\ProductObserver;

class AppServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        Order::observe(OrderObserver::class);
        Product::observe(ProductObserver::class);
    }
}
`

describe('scanObservers — Model::observe()', () => {
  it('creates observer nodes and observes_model edges', () => {
    const ctx = buildContext([
      { source: OBSERVER_PROVIDER, filePath: 'src/Providers/AppServiceProvider.php' },
    ])
    scanObservers(ctx)

    expect(nodeExists(ctx, 'observer:App\\Observers\\OrderObserver')).toBe(true)
    expect(nodeExists(ctx, 'observer:App\\Observers\\ProductObserver')).toBe(true)

    expect(edgeExists(ctx,
      'observer:App\\Observers\\OrderObserver',
      'model:App\\Models\\Order',
      'observes_model',
    )).toBe(true)
    expect(edgeExists(ctx,
      'observer:App\\Observers\\ProductObserver',
      'model:App\\Models\\Product',
      'observes_model',
    )).toBe(true)
  })

  it('creates model nodes', () => {
    const ctx = buildContext([
      { source: OBSERVER_PROVIDER, filePath: 'src/Providers/AppServiceProvider.php' },
    ])
    scanObservers(ctx)

    expect(nodeExists(ctx, 'model:App\\Models\\Order')).toBe(true)
    expect(nodeExists(ctx, 'model:App\\Models\\Product')).toBe(true)
  })
})

// ── edge properties ──

describe('K2.1.2b scanner edges — confidence and source', () => {
  it('all scanner edges are exact/laravel_scanner', () => {
    const ctx = buildContext([
      { source: EVENT_SERVICE_PROVIDER, filePath: 'src/Providers/EventServiceProvider.php' },
    ])
    scanEventsAndListeners(ctx)

    const scannerEdges = ctx.edges.filter(e => e.source === 'laravel_scanner')
    expect(scannerEdges.length).toBeGreaterThan(0)
    for (const e of scannerEdges) {
      expect(e.confidence).toBe('exact')
    }
  })
})
