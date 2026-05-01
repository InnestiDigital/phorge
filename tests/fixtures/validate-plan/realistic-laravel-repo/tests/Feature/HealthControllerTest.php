<?php

namespace Tests\Feature;

use Tests\TestCase;

class HealthControllerTest extends TestCase
{
    public function test_health_returns_ok(): void
    {
        $response = $this->get('/health');
        $response->assertStatus(200);
    }
}
