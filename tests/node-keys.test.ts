import { describe, it, expect } from 'vitest'
import {
  fileKey,
  classKey,
  interfaceKey,
  traitKey,
  methodKey,
  functionKey,
  routeKey,
  eventKey,
  listenerKey,
  jobKey,
  observerKey,
  policyKey,
  modelKey,
  serviceBindingKey,
  commandKey,
  resourceKey,
  transformerKey,
  stripLeadingSlash,
  normalizeNamespace,
  normalizeRepoPath,
  normalizeHttpMethod,
} from '../src/graphs/node-keys'

describe('fileKey', () => {
  it('creates file key from repo-relative path', () => {
    expect(fileKey('src/Shop/Checkout.php')).toBe('file:src/Shop/Checkout.php')
  })

  it('strips leading ./', () => {
    expect(fileKey('./src/A.php')).toBe('file:src/A.php')
  })

  it('strips leading /', () => {
    expect(fileKey('/src/A.php')).toBe('file:src/A.php')
  })

  it('normalizes backslashes to forward slashes', () => {
    expect(fileKey('src\\Shop\\A.php')).toBe('file:src/Shop/A.php')
  })

  it('collapses duplicate slashes', () => {
    expect(fileKey('src//Shop///A.php')).toBe('file:src/Shop/A.php')
  })
})

describe('classKey', () => {
  it('creates class key from FQCN', () => {
    expect(classKey('Services\\Shop\\Checkout\\AuthorizePayment')).toBe(
      'class:Services\\Shop\\Checkout\\AuthorizePayment',
    )
  })

  it('strips leading backslash', () => {
    expect(classKey('\\App\\Models\\Order')).toBe('class:App\\Models\\Order')
  })
})

describe('interfaceKey', () => {
  it('creates interface key', () => {
    expect(interfaceKey('Services\\Shop\\StepInterface')).toBe(
      'interface:Services\\Shop\\StepInterface',
    )
  })
})

describe('traitKey', () => {
  it('creates trait key', () => {
    expect(traitKey('Services\\Shop\\CheckoutTrait')).toBe(
      'trait:Services\\Shop\\CheckoutTrait',
    )
  })
})

describe('methodKey', () => {
  it('creates method key from FQCN and method name', () => {
    expect(methodKey('Services\\Shop\\AuthorizePayment', 'handle')).toBe(
      'method:Services\\Shop\\AuthorizePayment::handle',
    )
  })

  it('strips leading backslash from FQCN', () => {
    expect(methodKey('\\App\\Models\\Order', 'updateStatus')).toBe(
      'method:App\\Models\\Order::updateStatus',
    )
  })
})

describe('functionKey', () => {
  it('creates key for global function', () => {
    expect(functionKey('array_merge')).toBe('function:array_merge')
  })

  it('creates key for namespaced function', () => {
    expect(functionKey('App\\Support\\foo_helper')).toBe(
      'function:App\\Support\\foo_helper',
    )
  })
})

describe('routeKey', () => {
  it('creates route key with uppercase method', () => {
    expect(routeKey('post', '/api/v1/checkout')).toBe(
      'route:POST:/api/v1/checkout',
    )
  })

  it('preserves param placeholders', () => {
    expect(routeKey('GET', '/api/v1/orders/{id}')).toBe(
      'route:GET:/api/v1/orders/{id}',
    )
  })

  it('trims whitespace from URI', () => {
    expect(routeKey('GET', '  /api/v1/orders  ')).toBe(
      'route:GET:/api/v1/orders',
    )
  })
})

describe('Laravel domain keys', () => {
  it('eventKey', () => {
    expect(eventKey('App\\Events\\OrderDispatched')).toBe('event:App\\Events\\OrderDispatched')
  })

  it('listenerKey', () => {
    expect(listenerKey('App\\Listeners\\HandleOrder')).toBe('listener:App\\Listeners\\HandleOrder')
  })

  it('jobKey', () => {
    expect(jobKey('App\\Jobs\\ProcessOrder')).toBe('job:App\\Jobs\\ProcessOrder')
  })

  it('observerKey', () => {
    expect(observerKey('App\\Observers\\OrderObserver')).toBe('observer:App\\Observers\\OrderObserver')
  })

  it('policyKey', () => {
    expect(policyKey('App\\Policies\\OrderPolicy')).toBe('policy:App\\Policies\\OrderPolicy')
  })

  it('modelKey', () => {
    expect(modelKey('App\\Models\\Order')).toBe('model:App\\Models\\Order')
  })

  it('serviceBindingKey', () => {
    expect(serviceBindingKey('Services\\Shop\\StepInterface')).toBe(
      'service_binding:Services\\Shop\\StepInterface',
    )
  })

  it('commandKey', () => {
    expect(commandKey('App\\Console\\Commands\\SyncProducts')).toBe(
      'command:App\\Console\\Commands\\SyncProducts',
    )
  })

  it('resourceKey', () => {
    expect(resourceKey('App\\Http\\Resources\\OrderResource')).toBe(
      'resource:App\\Http\\Resources\\OrderResource',
    )
  })

  it('transformerKey', () => {
    expect(transformerKey('App\\Http\\Transformers\\OrderTransformer')).toBe(
      'transformer:App\\Http\\Transformers\\OrderTransformer',
    )
  })
})

describe('normalization helpers', () => {
  it('stripLeadingSlash removes leading backslash', () => {
    expect(stripLeadingSlash('\\App\\Models')).toBe('App\\Models')
  })

  it('stripLeadingSlash is no-op when no leading slash', () => {
    expect(stripLeadingSlash('App\\Models')).toBe('App\\Models')
  })

  it('normalizeNamespace strips leading backslash', () => {
    expect(normalizeNamespace('\\App\\Models\\Order')).toBe('App\\Models\\Order')
  })

  it('normalizeRepoPath normalizes separators and strips prefixes', () => {
    expect(normalizeRepoPath('./src\\Shop//A.php')).toBe('src/Shop/A.php')
  })

  it('normalizeHttpMethod uppercases', () => {
    expect(normalizeHttpMethod('post')).toBe('POST')
  })
})
