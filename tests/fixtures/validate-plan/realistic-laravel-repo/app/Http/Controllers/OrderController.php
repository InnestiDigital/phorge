<?php

namespace App\Http\Controllers;

use App\Jobs\ProcessOrderJob;
use App\Services\OrderService;
use Illuminate\Http\Request;
use Illuminate\Routing\Controller;

class OrderController extends Controller
{
    public function __construct(private OrderService $service) {}

    public function store(Request $request)
    {
        $order = $this->service->create($request->all());
        ProcessOrderJob::dispatch($order);
        return response()->json($order, 201);
    }

    public function show(int $id)
    {
        return $this->service->find($id);
    }
}
