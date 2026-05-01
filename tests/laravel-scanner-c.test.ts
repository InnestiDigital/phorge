import { describe, it, expect } from 'vitest'
import { extractFromSource } from '../src/graphs/extractor'
import { parsePhpFile } from '../src/graphs/php-parser'
import {
  scanPolicies,
  scanBindings,
  scanCommands,
  scanResourcesAndTransformers,
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

// ── scanPolicies ──

const POLICY_PROVIDER = `<?php
namespace App\\Providers;

use Illuminate\\Foundation\\Support\\Providers\\AuthServiceProvider as ServiceProvider;
use App\\Models\\Order;
use App\\Models\\Product;
use App\\Policies\\OrderPolicy;
use App\\Policies\\ProductPolicy;

class AuthServiceProvider extends ServiceProvider
{
    protected $policies = [
        Order::class => OrderPolicy::class,
        Product::class => ProductPolicy::class,
    ];
}
`

describe('scanPolicies — $policies array', () => {
  it('creates policy and model nodes', () => {
    const ctx = buildContext([{ source: POLICY_PROVIDER, filePath: 'src/Providers/AuthServiceProvider.php' }])
    scanPolicies(ctx)

    expect(nodeExists(ctx, 'policy:App\\Policies\\OrderPolicy')).toBe(true)
    expect(nodeExists(ctx, 'policy:App\\Policies\\ProductPolicy')).toBe(true)
    expect(nodeExists(ctx, 'model:App\\Models\\Order')).toBe(true)
    expect(nodeExists(ctx, 'model:App\\Models\\Product')).toBe(true)
  })

  it('creates authorizes_policy edges', () => {
    const ctx = buildContext([{ source: POLICY_PROVIDER, filePath: 'src/Providers/AuthServiceProvider.php' }])
    scanPolicies(ctx)

    expect(edgeExists(ctx,
      'policy:App\\Policies\\OrderPolicy',
      'model:App\\Models\\Order',
      'authorizes_policy',
    )).toBe(true)
    expect(edgeExists(ctx,
      'policy:App\\Policies\\ProductPolicy',
      'model:App\\Models\\Product',
      'authorizes_policy',
    )).toBe(true)
  })
})

// ── scanBindings ──

const BINDING_PROVIDER = `<?php
namespace App\\Providers;

use Illuminate\\Support\\ServiceProvider;
use App\\Contracts\\PaymentGateway;
use App\\Services\\StripeGateway;
use App\\Contracts\\Cache;
use App\\Services\\RedisCache;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->bind(PaymentGateway::class, StripeGateway::class);
        $this->app->singleton(Cache::class, RedisCache::class);
    }
}
`

describe('scanBindings — bind/singleton', () => {
  it('creates service_binding nodes and edges', () => {
    const ctx = buildContext([{ source: BINDING_PROVIDER, filePath: 'src/Providers/AppServiceProvider.php' }])
    scanBindings(ctx)

    expect(nodeExists(ctx, 'service_binding:App\\Contracts\\PaymentGateway')).toBe(true)
    expect(edgeExists(ctx,
      'file:src/Providers/AppServiceProvider.php',
      'service_binding:App\\Contracts\\PaymentGateway',
      'binds_service',
    )).toBe(true)
    expect(edgeExists(ctx,
      'service_binding:App\\Contracts\\PaymentGateway',
      'class:App\\Services\\StripeGateway',
      'binds_concrete',
    )).toBe(true)
  })

  it('handles singleton bindings', () => {
    const ctx = buildContext([{ source: BINDING_PROVIDER, filePath: 'src/Providers/AppServiceProvider.php' }])
    scanBindings(ctx)

    expect(nodeExists(ctx, 'service_binding:App\\Contracts\\Cache')).toBe(true)
    expect(edgeExists(ctx,
      'service_binding:App\\Contracts\\Cache',
      'class:App\\Services\\RedisCache',
      'binds_concrete',
    )).toBe(true)
  })

  it('stores binding metadata', () => {
    const ctx = buildContext([{ source: BINDING_PROVIDER, filePath: 'src/Providers/AppServiceProvider.php' }])
    scanBindings(ctx)

    const bindNode = ctx.nodes.get('service_binding:App\\Contracts\\PaymentGateway')
    expect(bindNode?.metadata?.bindingKind).toBe('bind')
    const singletonNode = ctx.nodes.get('service_binding:App\\Contracts\\Cache')
    expect(singletonNode?.metadata?.bindingKind).toBe('singleton')
  })
})

const DYNAMIC_BINDING = `<?php
namespace App\\Providers;

use Illuminate\\Support\\ServiceProvider;

class DynamicProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton('mcp.server', function ($app) {
            return new SomeService();
        });
    }
}
`

describe('scanBindings — dynamic/string bindings', () => {
  it('skips string-keyed bindings (not class references)', () => {
    const ctx = buildContext([{ source: DYNAMIC_BINDING, filePath: 'src/Providers/DynamicProvider.php' }])
    const result = scanBindings(ctx)
    expect(result.skipped).toBeGreaterThan(0)
  })
})

// ── scanCommands ──

const COMMAND_FILE = `<?php
namespace App\\Console\\Commands;

use Illuminate\\Console\\Command;

class SyncProducts extends Command
{
    protected $signature = 'products:sync {--force}';

    public function handle(): int
    {
        return self::SUCCESS;
    }
}
`

describe('scanCommands', () => {
  it('creates command node for class extending Command', () => {
    const ctx = buildContext([{ source: COMMAND_FILE, filePath: 'app/Console/Commands/SyncProducts.php' }])
    scanCommands(ctx)

    expect(nodeExists(ctx, 'command:App\\Console\\Commands\\SyncProducts')).toBe(true)
  })

  it('captures signature metadata', () => {
    const ctx = buildContext([{ source: COMMAND_FILE, filePath: 'app/Console/Commands/SyncProducts.php' }])
    scanCommands(ctx)

    const cmd = ctx.nodes.get('command:App\\Console\\Commands\\SyncProducts')
    expect(cmd?.metadata?.signature).toBe('products:sync {--force}')
  })
})

// ── scanResourcesAndTransformers ──

const TRANSFORMER_FILE = `<?php
namespace App\\Http\\Transformers;

use App\\Models\\Order;

class OrderShowTransformer extends Transformer
{
    public function transform(Order $order): array
    {
        return ['id' => $order->id];
    }
}
`

describe('scanResourcesAndTransformers — transformers', () => {
  it('creates transformer node', () => {
    const ctx = buildContext([{ source: TRANSFORMER_FILE, filePath: 'src/Http/Transformers/OrderShowTransformer.php' }])
    scanResourcesAndTransformers(ctx)

    expect(nodeExists(ctx, 'transformer:App\\Http\\Transformers\\OrderShowTransformer')).toBe(true)
  })

  it('creates transformer_transforms_model edge from transform() typed param', () => {
    const ctx = buildContext([{ source: TRANSFORMER_FILE, filePath: 'src/Http/Transformers/OrderShowTransformer.php' }])
    scanResourcesAndTransformers(ctx)

    expect(edgeExists(ctx,
      'transformer:App\\Http\\Transformers\\OrderShowTransformer',
      'model:App\\Models\\Order',
      'transformer_transforms_model',
    )).toBe(true)
  })
})

// ── edge confidence ──

describe('K2.1.2c scanner edges — all exact/laravel_scanner', () => {
  it('policy edges are exact', () => {
    const ctx = buildContext([{ source: POLICY_PROVIDER, filePath: 'src/Providers/AuthServiceProvider.php' }])
    scanPolicies(ctx)
    const pEdges = ctx.edges.filter(e => e.kind === 'authorizes_policy')
    for (const e of pEdges) {
      expect(e.confidence).toBe('exact')
      expect(e.source).toBe('laravel_scanner')
    }
  })
})
