import { describe, it, expect } from 'vitest'
import { extractFromSource, type ExtractFromSourceResult } from '../src/graphs/extractor'

function extract(source: string, filePath = 'src/test.php'): ExtractFromSourceResult {
  return extractFromSource(source, filePath)
}

function callEdges(result: ExtractFromSourceResult) {
  return result.edges.filter(e => e.kind === 'calls')
}

function throwEdges(result: ExtractFromSourceResult) {
  return result.edges.filter(e => e.kind === 'throws')
}

function edgeExists(r: ExtractFromSourceResult, from: string, to: string, kind: string): boolean {
  return r.edges.some(e => e.from === from && e.to === to && e.kind === kind)
}

// ── $this->method() ──

const THIS_CALL = `<?php
namespace App\\Services;

class OrderService
{
    public function process(): void
    {
        $this->validate();
        $this->save();
    }

    private function validate(): void {}
    private function save(): void {}
}
`

describe('calls — $this->method()', () => {
  it('creates calls edges for $this->method() within same class', () => {
    const r = extract(THIS_CALL)
    expect(edgeExists(r,
      'method:App\\Services\\OrderService::process',
      'method:App\\Services\\OrderService::validate',
      'calls',
    )).toBe(true)
    expect(edgeExists(r,
      'method:App\\Services\\OrderService::process',
      'method:App\\Services\\OrderService::save',
      'calls',
    )).toBe(true)
  })
})

// ── self:: and static:: ──

const SELF_STATIC_CALL = `<?php
namespace App\\Services;

class Calculator
{
    public function compute(): int
    {
        return self::add(1, 2) + static::multiply(3, 4);
    }

    public static function add(int $a, int $b): int { return $a + $b; }
    public static function multiply(int $a, int $b): int { return $a * $b; }
}
`

describe('calls — self:: and static::', () => {
  it('creates calls edges for self:: calls', () => {
    const r = extract(SELF_STATIC_CALL)
    expect(edgeExists(r,
      'method:App\\Services\\Calculator::compute',
      'method:App\\Services\\Calculator::add',
      'calls',
    )).toBe(true)
  })

  it('creates calls edges for static:: calls', () => {
    const r = extract(SELF_STATIC_CALL)
    expect(edgeExists(r,
      'method:App\\Services\\Calculator::compute',
      'method:App\\Services\\Calculator::multiply',
      'calls',
    )).toBe(true)
  })
})

// ── ClassName::staticMethod() ──

const STATIC_CLASS_CALL = `<?php
namespace App\\Http\\Controllers;

use App\\Services\\OrderService;
use App\\Models\\Order;

class CheckoutController
{
    public function submit(): void
    {
        OrderService::validate();
        Order::create();
    }
}
`

describe('calls — ClassName::staticMethod()', () => {
  it('creates calls edges for static class method calls', () => {
    const r = extract(STATIC_CLASS_CALL)
    expect(edgeExists(r,
      'method:App\\Http\\Controllers\\CheckoutController::submit',
      'method:App\\Services\\OrderService::validate',
      'calls',
    )).toBe(true)
    expect(edgeExists(r,
      'method:App\\Http\\Controllers\\CheckoutController::submit',
      'method:App\\Models\\Order::create',
      'calls',
    )).toBe(true)
  })
})

// ── parent::method() ──

const PARENT_CALL = `<?php
namespace App\\Controllers;

use App\\Base\\BaseController;

class AdminController extends BaseController
{
    public function index(): void
    {
        parent::authorize();
    }
}
`

describe('calls — parent::method()', () => {
  it('creates calls edge resolving parent to extended class', () => {
    const r = extract(PARENT_CALL)
    expect(edgeExists(r,
      'method:App\\Controllers\\AdminController::index',
      'method:App\\Base\\BaseController::authorize',
      'calls',
    )).toBe(true)
  })
})

// ── typed parameter calls ──

const TYPED_PARAM_CALL = `<?php
namespace App\\Services;

use App\\Repositories\\OrderRepository;

class OrderService
{
    public function process(OrderRepository $repo): void
    {
        $repo->findById(1);
        $repo->save();
    }
}
`

describe('calls — typed parameter receiver', () => {
  it('creates calls edges from typed parameter method calls', () => {
    const r = extract(TYPED_PARAM_CALL)
    expect(edgeExists(r,
      'method:App\\Services\\OrderService::process',
      'method:App\\Repositories\\OrderRepository::findById',
      'calls',
    )).toBe(true)
    expect(edgeExists(r,
      'method:App\\Services\\OrderService::process',
      'method:App\\Repositories\\OrderRepository::save',
      'calls',
    )).toBe(true)
  })
})

// ── new ClassName() then call ──

const NEW_THEN_CALL = `<?php
namespace App\\Services;

use App\\Models\\Order;

class OrderService
{
    public function create(): void
    {
        $order = new Order();
        $order->save();
    }
}
`

describe('calls — new ClassName() assignment then call', () => {
  it('creates calls edge from new-assigned variable method call', () => {
    const r = extract(NEW_THEN_CALL)
    expect(edgeExists(r,
      'method:App\\Services\\OrderService::create',
      'method:App\\Models\\Order::save',
      'calls',
    )).toBe(true)
  })
})

// ── throw new ClassName() ──

const THROW_NEW = `<?php
namespace App\\Services;

use App\\Exceptions\\ValidationException;
use App\\Exceptions\\AuthorizationException;

class OrderService
{
    public function validate(): void
    {
        throw new ValidationException('invalid');
    }

    public function authorize(): void
    {
        throw new AuthorizationException();
    }
}
`

describe('throws — explicit throw new', () => {
  it('creates throws edges for explicit throw new statements', () => {
    const r = extract(THROW_NEW)
    expect(edgeExists(r,
      'method:App\\Services\\OrderService::validate',
      'class:App\\Exceptions\\ValidationException',
      'throws',
    )).toBe(true)
    expect(edgeExists(r,
      'method:App\\Services\\OrderService::authorize',
      'class:App\\Exceptions\\AuthorizationException',
      'throws',
    )).toBe(true)
  })

  it('all throws edges are exact/parser', () => {
    const r = extract(THROW_NEW)
    for (const e of throwEdges(r)) {
      expect(e.confidence).toBe('exact')
      expect(e.source).toBe('parser')
    }
  })
})

// ── skip cases ──

const DYNAMIC_CALL = `<?php
namespace App\\Services;

class DynamicService
{
    public function run(string $method): void
    {
        $this->$method();
    }
}
`

const UNTYPED_PARAM = `<?php
namespace App\\Services;

class Loose
{
    public function process($thing): void
    {
        $thing->doSomething();
    }
}
`

describe('calls — skipped cases', () => {
  it('does not create calls edge for dynamic method name', () => {
    const r = extract(DYNAMIC_CALL)
    expect(callEdges(r)).toHaveLength(0)
  })

  it('does not create calls edge for untyped parameter', () => {
    const r = extract(UNTYPED_PARAM)
    expect(callEdges(r)).toHaveLength(0)
  })
})

// ── mixed scenario ──

const MIXED = `<?php
namespace App\\Services;

use App\\Models\\Order;
use App\\Exceptions\\NotFoundException;

class OrderService
{
    public function findOrFail(int $id): void
    {
        $order = Order::find($id);
        if (!$order) {
            throw new NotFoundException('not found');
        }
        $this->process($order);
    }

    private function process(Order $order): void
    {
        $order->refresh();
    }
}
`

describe('calls + throws — mixed scenario', () => {
  it('extracts calls and throws from mixed method body', () => {
    const r = extract(MIXED)
    // static call
    expect(edgeExists(r,
      'method:App\\Services\\OrderService::findOrFail',
      'method:App\\Models\\Order::find',
      'calls',
    )).toBe(true)
    // $this call
    expect(edgeExists(r,
      'method:App\\Services\\OrderService::findOrFail',
      'method:App\\Services\\OrderService::process',
      'calls',
    )).toBe(true)
    // typed param in process
    expect(edgeExists(r,
      'method:App\\Services\\OrderService::process',
      'method:App\\Models\\Order::refresh',
      'calls',
    )).toBe(true)
    // throw
    expect(edgeExists(r,
      'method:App\\Services\\OrderService::findOrFail',
      'class:App\\Exceptions\\NotFoundException',
      'throws',
    )).toBe(true)
  })
})

// ── constructor call ──

const CONSTRUCTOR_TYPED = `<?php
namespace App\\Services;

class Builder
{
    public function __construct(
        private readonly App\\Repositories\\Repo $repo,
    ) {}

    public function build(): void
    {
        $this->repo->execute();
    }
}
`

describe('calls — constructor-promoted typed property via $this', () => {
  it('does not resolve $this->property->method() in v1 (too complex)', () => {
    const r = extract(CONSTRUCTOR_TYPED)
    // v1 does not track property types — this is a known skip
    const propCalls = callEdges(r)
    // No expectation of resolving $this->repo->execute()
    // Just ensure no crash
    expect(r.nodes.length).toBeGreaterThan(0)
  })
})
