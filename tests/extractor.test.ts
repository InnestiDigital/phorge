import { describe, it, expect } from 'vitest'
import { extractFromSource, type ExtractFromSourceResult } from '../src/graphs/extractor'

const SIMPLE_CLASS = `<?php
namespace Services\\Shop\\Checkout\\Steps\\ProcessSteps;

use Services\\Shop\\Checkout\\Steps\\StepInterface;

class AuthorizePayment implements StepInterface
{
    public function handle($orderRef, \\Closure $next)
    {
        return $next($orderRef);
    }

    private function authorize(): bool
    {
        return true;
    }
}
`

const CLASS_WITH_EXTENDS_AND_TRAITS = `<?php
namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;
use App\\Traits\\Auditable;

class Order extends Model
{
    use Auditable;

    public function updateStatus(string $status): void
    {
        $this->status = $status;
    }

    protected function recalculate(): void {}
}
`

const INTERFACE_FILE = `<?php
namespace Services\\Shop\\Checkout\\Steps;

interface StepInterface
{
    public function handle($orderRef, \\Closure $next);
}
`

const TRAIT_FILE = `<?php
namespace App\\Traits;

trait Auditable
{
    public function getAuditLog(): array
    {
        return [];
    }
}
`

const MULTIPLE_IMPLEMENTS = `<?php
namespace App\\Jobs;

use Illuminate\\Contracts\\Queue\\ShouldQueue;
use App\\Contracts\\Trackable;

class ProcessOrder implements ShouldQueue, Trackable
{
    public function handle(): void {}
}
`

const MULTIPLE_TRAITS = `<?php
namespace App\\Models;

use App\\Traits\\Auditable;
use App\\Traits\\Cacheable;

class Product
{
    use Auditable, Cacheable;

    public function sync(): void {}
}
`

const NO_NAMESPACE = `<?php
class GlobalHelper
{
    public function run(): void {}
}
`

const ABSTRACT_CLASS = `<?php
namespace App\\Base;

abstract class BaseController
{
    abstract public function index();
    public function show(): void {}
}
`

const EMPTY_FILE = `<?php
`

function extract(source: string, filePath = 'src/test.php'): ExtractFromSourceResult {
  return extractFromSource(source, filePath)
}

function nodeByKey(result: ExtractFromSourceResult, key: string) {
  return result.nodes.find(n => n.key === key)
}

function edgeExists(result: ExtractFromSourceResult, from: string, to: string, kind: string): boolean {
  return result.edges.some(e => e.from === from && e.to === to && e.kind === kind)
}

describe('extractFromSource — file nodes', () => {
  it('creates a file node for every parsed file', () => {
    const r = extract(SIMPLE_CLASS, 'src/Shop/Checkout/Steps/ProcessSteps/AuthorizePayment.php')
    const file = nodeByKey(r, 'file:src/Shop/Checkout/Steps/ProcessSteps/AuthorizePayment.php')
    expect(file).toBeDefined()
    expect(file!.kind).toBe('file')
    expect(file!.name).toBe('AuthorizePayment.php')
  })

  it('creates file node for empty file', () => {
    const r = extract(EMPTY_FILE, 'src/empty.php')
    expect(nodeByKey(r, 'file:src/empty.php')).toBeDefined()
  })
})

describe('extractFromSource — class nodes', () => {
  it('creates class node with correct FQCN', () => {
    const r = extract(SIMPLE_CLASS, 'src/AuthorizePayment.php')
    const cls = nodeByKey(r, 'class:Services\\Shop\\Checkout\\Steps\\ProcessSteps\\AuthorizePayment')
    expect(cls).toBeDefined()
    expect(cls!.kind).toBe('class')
    expect(cls!.name).toBe('AuthorizePayment')
    expect(cls!.fqcn).toBe('Services\\Shop\\Checkout\\Steps\\ProcessSteps\\AuthorizePayment')
  })

  it('creates abstract class node', () => {
    const r = extract(ABSTRACT_CLASS, 'src/Base/BaseController.php')
    const cls = nodeByKey(r, 'class:App\\Base\\BaseController')
    expect(cls).toBeDefined()
    expect(cls!.isAbstract).toBe(true)
  })

  it('handles class without namespace', () => {
    const r = extract(NO_NAMESPACE, 'src/GlobalHelper.php')
    const cls = nodeByKey(r, 'class:GlobalHelper')
    expect(cls).toBeDefined()
  })
})

describe('extractFromSource — interface nodes', () => {
  it('creates interface node', () => {
    const r = extract(INTERFACE_FILE, 'src/StepInterface.php')
    const iface = nodeByKey(r, 'interface:Services\\Shop\\Checkout\\Steps\\StepInterface')
    expect(iface).toBeDefined()
    expect(iface!.kind).toBe('interface')
  })
})

describe('extractFromSource — trait nodes', () => {
  it('creates trait node', () => {
    const r = extract(TRAIT_FILE, 'src/Auditable.php')
    const tr = nodeByKey(r, 'trait:App\\Traits\\Auditable')
    expect(tr).toBeDefined()
    expect(tr!.kind).toBe('trait')
  })
})

describe('extractFromSource — method nodes', () => {
  it('creates method nodes for each method in class', () => {
    const r = extract(SIMPLE_CLASS, 'src/AuthorizePayment.php')
    const handle = nodeByKey(r, 'method:Services\\Shop\\Checkout\\Steps\\ProcessSteps\\AuthorizePayment::handle')
    expect(handle).toBeDefined()
    expect(handle!.kind).toBe('method')
    expect(handle!.visibility).toBe('public')

    const authorize = nodeByKey(r, 'method:Services\\Shop\\Checkout\\Steps\\ProcessSteps\\AuthorizePayment::authorize')
    expect(authorize).toBeDefined()
    expect(authorize!.visibility).toBe('private')
  })

  it('creates method nodes for interface methods', () => {
    const r = extract(INTERFACE_FILE, 'src/StepInterface.php')
    const m = nodeByKey(r, 'method:Services\\Shop\\Checkout\\Steps\\StepInterface::handle')
    expect(m).toBeDefined()
  })

  it('creates method nodes for trait methods', () => {
    const r = extract(TRAIT_FILE, 'src/Auditable.php')
    const m = nodeByKey(r, 'method:App\\Traits\\Auditable::getAuditLog')
    expect(m).toBeDefined()
  })
})

describe('extractFromSource — defines edges', () => {
  it('creates defines edge from file to class', () => {
    const r = extract(SIMPLE_CLASS, 'src/AuthorizePayment.php')
    expect(edgeExists(r,
      'file:src/AuthorizePayment.php',
      'class:Services\\Shop\\Checkout\\Steps\\ProcessSteps\\AuthorizePayment',
      'defines',
    )).toBe(true)
  })

  it('creates defines edge from file to interface', () => {
    const r = extract(INTERFACE_FILE, 'src/StepInterface.php')
    expect(edgeExists(r,
      'file:src/StepInterface.php',
      'interface:Services\\Shop\\Checkout\\Steps\\StepInterface',
      'defines',
    )).toBe(true)
  })

  it('creates defines edge from file to trait', () => {
    const r = extract(TRAIT_FILE, 'src/Auditable.php')
    expect(edgeExists(r,
      'file:src/Auditable.php',
      'trait:App\\Traits\\Auditable',
      'defines',
    )).toBe(true)
  })
})

describe('extractFromSource — contains_method edges', () => {
  it('creates contains_method from class to method', () => {
    const r = extract(SIMPLE_CLASS, 'src/AuthorizePayment.php')
    expect(edgeExists(r,
      'class:Services\\Shop\\Checkout\\Steps\\ProcessSteps\\AuthorizePayment',
      'method:Services\\Shop\\Checkout\\Steps\\ProcessSteps\\AuthorizePayment::handle',
      'contains_method',
    )).toBe(true)
  })
})

describe('extractFromSource — extends edges', () => {
  it('creates extends edge when class extends another', () => {
    const r = extract(CLASS_WITH_EXTENDS_AND_TRAITS, 'src/Order.php')
    expect(edgeExists(r,
      'class:App\\Models\\Order',
      'class:Illuminate\\Database\\Eloquent\\Model',
      'extends',
    )).toBe(true)
  })
})

describe('extractFromSource — implements edges', () => {
  it('creates implements edge', () => {
    const r = extract(SIMPLE_CLASS, 'src/AuthorizePayment.php')
    expect(edgeExists(r,
      'class:Services\\Shop\\Checkout\\Steps\\ProcessSteps\\AuthorizePayment',
      'interface:Services\\Shop\\Checkout\\Steps\\StepInterface',
      'implements',
    )).toBe(true)
  })

  it('creates multiple implements edges', () => {
    const r = extract(MULTIPLE_IMPLEMENTS, 'src/ProcessOrder.php')
    expect(edgeExists(r,
      'class:App\\Jobs\\ProcessOrder',
      'interface:Illuminate\\Contracts\\Queue\\ShouldQueue',
      'implements',
    )).toBe(true)
    expect(edgeExists(r,
      'class:App\\Jobs\\ProcessOrder',
      'interface:App\\Contracts\\Trackable',
      'implements',
    )).toBe(true)
  })
})

describe('extractFromSource — uses_trait edges', () => {
  it('creates uses_trait edge', () => {
    const r = extract(CLASS_WITH_EXTENDS_AND_TRAITS, 'src/Order.php')
    expect(edgeExists(r,
      'class:App\\Models\\Order',
      'trait:App\\Traits\\Auditable',
      'uses_trait',
    )).toBe(true)
  })

  it('creates multiple uses_trait edges', () => {
    const r = extract(MULTIPLE_TRAITS, 'src/Product.php')
    expect(edgeExists(r,
      'class:App\\Models\\Product',
      'trait:App\\Traits\\Auditable',
      'uses_trait',
    )).toBe(true)
    expect(edgeExists(r,
      'class:App\\Models\\Product',
      'trait:App\\Traits\\Cacheable',
      'uses_trait',
    )).toBe(true)
  })
})

describe('extractFromSource — edge deduplication', () => {
  it('does not produce duplicate edges', () => {
    const r = extract(SIMPLE_CLASS, 'src/AuthorizePayment.php')
    const definesEdges = r.edges.filter(e =>
      e.from === 'file:src/AuthorizePayment.php' &&
      e.kind === 'defines',
    )
    const uniqueTargets = new Set(definesEdges.map(e => e.to))
    expect(definesEdges.length).toBe(uniqueTargets.size)
  })
})

describe('extractFromSource — all edges are exact/parser', () => {
  it('all edges have confidence exact and source parser', () => {
    const r = extract(SIMPLE_CLASS, 'src/AuthorizePayment.php')
    for (const e of r.edges) {
      expect(e.confidence).toBe('exact')
      expect(e.source).toBe('parser')
    }
  })
})
