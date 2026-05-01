<?php

namespace Tests\Feature;

use App\Services\OrderService;
use Tests\TestCase;

class OrderServiceTest extends TestCase
{
    public function test_creates_order(): void
    {
        $svc = $this->app->make(OrderService::class);
        $order = $svc->create(['type' => 'a', 'items' => []]);
        $this->assertNotNull($order);
    }
}
