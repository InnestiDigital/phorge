import { describe, it, expect } from 'vitest'
import { extractFromSource } from '../src/graphs/extractor'
import { parsePhpFile } from '../src/graphs/php-parser'
import {
  scanRoutes,
  scanControllerMethods,
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
    astCache.set(filePath, {
      ast: parsed.ast,
      filePath,
      namespace: result.namespace,
      useMap: result.useMap,
    })
    for (const sym of result.declaredSymbols) {
      fqcnIndex.set(sym, filePath)
    }
  }

  return { nodes: allNodes, edges: allEdges, edgeSet, astCache, fqcnIndex }
}

function edgeExists(ctx: LaravelScannerContext, from: string, to: string, kind: string): boolean {
  return ctx.edges.some(e => e.from === from && e.to === to && e.kind === kind)
}

function nodeExists(ctx: LaravelScannerContext, key: string): boolean {
  return ctx.nodes.has(key)
}

// ── scanRoutes ──

const ROUTE_FILE = `<?php
use Illuminate\\Support\\Facades\\Route;
use App\\Http\\Controllers\\OrderController;

Route::post('/checkout/submit', 'Member\\\\CheckoutController@store');
Route::get('/orders', [OrderController::class, 'index']);
Route::get('/orders/{id}', [OrderController::class, 'show']);
Route::post('/upload', function () { return 'ok'; });
`

describe('scanRoutes — string handler form', () => {
  it('creates route node and route_to_controller edge for @ syntax', () => {
    const ctx = buildContext([{ source: ROUTE_FILE, filePath: 'routes/checkout.php' }])
    scanRoutes(ctx)

    expect(nodeExists(ctx, 'route:POST:/checkout/submit')).toBe(true)
    expect(edgeExists(ctx,
      'route:POST:/checkout/submit',
      'method:Member\\CheckoutController::store',
      'route_to_controller',
    )).toBe(true)
  })
})

describe('scanRoutes — array tuple handler form', () => {
  it('creates route node and route_to_controller edge for [Class, method] syntax', () => {
    const ctx = buildContext([{ source: ROUTE_FILE, filePath: 'routes/checkout.php' }])
    scanRoutes(ctx)

    expect(nodeExists(ctx, 'route:GET:/orders')).toBe(true)
    expect(edgeExists(ctx,
      'route:GET:/orders',
      'method:App\\Http\\Controllers\\OrderController::index',
      'route_to_controller',
    )).toBe(true)
  })

  it('handles routes with params', () => {
    const ctx = buildContext([{ source: ROUTE_FILE, filePath: 'routes/checkout.php' }])
    scanRoutes(ctx)

    expect(nodeExists(ctx, 'route:GET:/orders/{id}')).toBe(true)
    expect(edgeExists(ctx,
      'route:GET:/orders/{id}',
      'method:App\\Http\\Controllers\\OrderController::show',
      'route_to_controller',
    )).toBe(true)
  })
})

describe('scanRoutes — closure handler', () => {
  it('creates route node but no controller edge for closures', () => {
    const ctx = buildContext([{ source: ROUTE_FILE, filePath: 'routes/checkout.php' }])
    scanRoutes(ctx)

    expect(nodeExists(ctx, 'route:POST:/upload')).toBe(true)
    const closureEdges = ctx.edges.filter(e =>
      e.from === 'route:POST:/upload' && e.kind === 'route_to_controller',
    )
    expect(closureEdges).toHaveLength(0)
  })
})

describe('scanRoutes — only processes route files', () => {
  it('does not scan non-route files', () => {
    const ctx = buildContext([{ source: ROUTE_FILE, filePath: 'src/Http/Controllers/Foo.php' }])
    const before = ctx.nodes.size
    scanRoutes(ctx)
    const routeNodes = [...ctx.nodes.values()].filter(n => n.kind === 'route')
    expect(routeNodes).toHaveLength(0)
  })
})

describe('scanRoutes — returns metrics', () => {
  it('reports routes found and skipped', () => {
    const ctx = buildContext([{ source: ROUTE_FILE, filePath: 'routes/checkout.php' }])
    const result = scanRoutes(ctx)
    expect(result.nodes).toBeGreaterThan(0)
    expect(result.edges).toBeGreaterThan(0)
    expect(result.skipped).toBeGreaterThan(0) // closure route
  })
})

// ── scanControllerMethods ──

const CONTROLLER_FILE = `<?php
namespace App\\Http\\Controllers;

use App\\Http\\Requests\\CheckoutRequest;
use App\\Http\\Requests\\OrderIndexRequest;
use Illuminate\\Http\\Request;

class CheckoutController extends Controller
{
    public function store(CheckoutRequest $request)
    {
        return response()->json([]);
    }

    public function index(OrderIndexRequest $request)
    {
        return response()->json([]);
    }

    public function show(Request $request, int $id)
    {
        return response()->json([]);
    }
}
`

describe('scanControllerMethods — FormRequest detection', () => {
  it('creates controller_uses_request edge for FormRequest-typed params', () => {
    const ctx = buildContext([{ source: CONTROLLER_FILE, filePath: 'src/Http/Controllers/CheckoutController.php' }])
    scanControllerMethods(ctx)

    expect(edgeExists(ctx,
      'method:App\\Http\\Controllers\\CheckoutController::store',
      'class:App\\Http\\Requests\\CheckoutRequest',
      'controller_uses_request',
    )).toBe(true)

    expect(edgeExists(ctx,
      'method:App\\Http\\Controllers\\CheckoutController::index',
      'class:App\\Http\\Requests\\OrderIndexRequest',
      'controller_uses_request',
    )).toBe(true)
  })

  it('does not create controller_uses_request for base Request class', () => {
    const ctx = buildContext([{ source: CONTROLLER_FILE, filePath: 'src/Http/Controllers/CheckoutController.php' }])
    scanControllerMethods(ctx)

    const showEdges = ctx.edges.filter(e =>
      e.from.includes('CheckoutController::show') && e.kind === 'controller_uses_request',
    )
    expect(showEdges).toHaveLength(0)
  })
})

describe('scanControllerMethods — laravelRole metadata', () => {
  it('adds laravelRole=controller to controller class node', () => {
    const ctx = buildContext([{ source: CONTROLLER_FILE, filePath: 'src/Http/Controllers/CheckoutController.php' }])
    scanControllerMethods(ctx)

    const ctrlNode = ctx.nodes.get('class:App\\Http\\Controllers\\CheckoutController')
    expect(ctrlNode?.laravelRole).toBe('controller')
  })
})

describe('scanControllerMethods — only processes controllers', () => {
  it('does not tag non-controller classes', () => {
    const nonCtrl = `<?php
namespace App\\Services;
class OrderService {
    public function process(): void {}
}
`
    const ctx = buildContext([{ source: nonCtrl, filePath: 'src/Services/OrderService.php' }])
    scanControllerMethods(ctx)

    const svcNode = ctx.nodes.get('class:App\\Services\\OrderService')
    expect(svcNode?.laravelRole).toBeUndefined()
  })
})

// ── edge properties ──

describe('Laravel scanner edges — confidence and source', () => {
  it('all scanner edges are exact/laravel_scanner', () => {
    const ctx = buildContext([{ source: ROUTE_FILE, filePath: 'routes/checkout.php' }])
    scanRoutes(ctx)

    const scannerEdges = ctx.edges.filter(e => e.source === 'laravel_scanner')
    expect(scannerEdges.length).toBeGreaterThan(0)
    for (const e of scannerEdges) {
      expect(e.confidence).toBe('exact')
      expect(e.source).toBe('laravel_scanner')
    }
  })
})
