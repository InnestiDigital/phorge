<?php

namespace App\Http\Controllers;

use Illuminate\Routing\Controller;

class HealthController extends Controller
{
    public function index()
    {
        return ['status' => 'ok'];
    }
}
