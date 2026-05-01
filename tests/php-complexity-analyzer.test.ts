import { describe, it, expect } from 'vitest'
import { analyzePhpComplexity } from '../src/profiles/php-complexity-analyzer'

describe('analyzePhpComplexity', () => {
  it('linear code has cyclomatic=1', () => {
    const src = `<?php
function plain() {
  $a = 1;
  $b = 2;
  return $a + $b;
}`
    const r = analyzePhpComplexity(src)
    expect(r.cyclomatic).toBe(1)
    expect(r.methodCount).toBe(1)
    expect(r.maxNesting).toBe(0)
  })

  it('if/else adds one branch', () => {
    const src = `<?php
function f($x) {
  if ($x > 0) { return 1; } else { return 0; }
}`
    const r = analyzePhpComplexity(src)
    expect(r.cyclomatic).toBe(2)
    expect(r.methodCount).toBe(1)
  })

  it('counts nested loops, switch cases, boolean operators', () => {
    const src = `<?php
function f($items) {
  foreach ($items as $i) {        // +1
    for ($j = 0; $j < 10; $j++) { // +1
      if ($i && $j) {              // +1 if, +1 &&
        switch ($i) {
          case 1: break;            // +1
          case 2: break;            // +1
          default: break;           // 0
        }
      }
    }
  }
}`
    const r = analyzePhpComplexity(src)
    // base 1 + foreach + for + if + && + 2 cases = 7
    expect(r.cyclomatic).toBe(7)
    expect(r.maxNesting).toBeGreaterThanOrEqual(4) // foreach > for > if > switch
  })

  it('counts ternary and ?? and catch', () => {
    const src = `<?php
function f($x, $y) {
  try {
    return $x ?? ($y > 0 ? 'a' : 'b');
  } catch (\\Exception $e) {
    return null;
  }
}`
    const r = analyzePhpComplexity(src)
    // base 1 + try-catch (+1 catch) + ?? (+1) + ternary (+1) = 4
    expect(r.cyclomatic).toBe(4)
  })

  it('degrades gracefully on broken PHP', () => {
    const src = `<?php this is { not (( valid php @@@`
    const r = analyzePhpComplexity(src)
    expect(r.cyclomatic).toBeGreaterThanOrEqual(1)
    expect(r.maxNesting).toBeGreaterThanOrEqual(0)
  })

  it('tracks method count and longest method', () => {
    const src = `<?php
class C {
  public function a() { return 1; }
  public function b() {
    $x = 1;
    $y = 2;
    $z = 3;
    return $x + $y + $z;
  }
}`
    const r = analyzePhpComplexity(src)
    expect(r.methodCount).toBe(2)
    expect(r.longestMethodLines).toBeGreaterThanOrEqual(5)
  })
})
