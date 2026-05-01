<?php

namespace App\Services;

use App\Models\Order;

class OrderService
{
    public function create(array $data): Order
    {
        // Intentionally complex method to trigger complexity checker.
        if ($data['type'] ?? null) {
            if ($data['type'] === 'a') {
                if (!empty($data['x'])) {
                    foreach ($data['items'] ?? [] as $item) {
                        if ($item['qty'] > 0) {
                            if ($item['price'] > 0) {
                                if ($item['tax'] ?? 0) {
                                    $item['total'] = $item['qty'] * $item['price'] * (1 + $item['tax']);
                                } else {
                                    $item['total'] = $item['qty'] * $item['price'];
                                }
                            }
                        }
                    }
                }
            } elseif ($data['type'] === 'b') {
                if ($data['discount'] ?? 0) {
                    if ($data['discount'] > 0.5) {
                        $data['flag'] = 'big';
                    } elseif ($data['discount'] > 0.2) {
                        $data['flag'] = 'med';
                    } else {
                        $data['flag'] = 'small';
                    }
                }
            } elseif ($data['type'] === 'c') {
                $data['flag'] = 'c';
            } elseif ($data['type'] === 'd') {
                $data['flag'] = 'd';
            } elseif ($data['type'] === 'e') {
                $data['flag'] = 'e';
            } elseif ($data['type'] === 'f') {
                $data['flag'] = 'f';
            } elseif ($data['type'] === 'g') {
                $data['flag'] = 'g';
            } elseif ($data['type'] === 'h') {
                $data['flag'] = 'h';
            }
        }

        for ($i = 0; $i < 10; $i++) {
            if ($i % 2 === 0) {
                $data['evens'][] = $i;
            } elseif ($i % 3 === 0) {
                $data['threes'][] = $i;
            } elseif ($i % 5 === 0) {
                $data['fives'][] = $i;
            }
        }

        while (!empty($data['queue'] ?? [])) {
            $job = array_shift($data['queue']);
            if ($job['kind'] === 'x') {
                $data['x'][] = $job;
            } elseif ($job['kind'] === 'y') {
                $data['y'][] = $job;
            } elseif ($job['kind'] === 'z') {
                $data['z'][] = $job;
            }
        }

        try {
            if ($data['validate'] ?? false) {
                if (empty($data['email'])) {
                    throw new \InvalidArgumentException('email');
                }
                if (empty($data['name'])) {
                    throw new \InvalidArgumentException('name');
                }
            }
        } catch (\InvalidArgumentException $e) {
            $data['error'] = $e->getMessage();
        } catch (\Throwable $e) {
            $data['error'] = 'unknown';
        }

        return Order::create($data);
    }

    public function find(int $id): ?Order
    {
        return Order::find($id);
    }
}
