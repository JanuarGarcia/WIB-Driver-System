# Standard (non-errand) orders — convenience / service fee in driver API

## Canonical fields (Flutter driver app)

For **`POST /GetTaskDetails`** and **`POST /GetTaskByDate`** (`details` / `details.data[]`), the backend aligns these:

| Priority | Field | Notes |
|----------|--------|--------|
| 1 | Root `convenience_fee` (+ `convenienceFee`) | Same value as nested when order exists. Omitted / `null` when no non-zero fee is found (not sent as `"0"` to avoid masking nested values). |
| 2 | `mt_order` / `order` / `order_info` | `service_fee`, `card_fee`, `convenience_fee`, totals (`sub_total`, `total_w_tax`, `order_total_amount`, …). |
| 3 | `mt_order_delivery_address` / `order_delivery_address` | `service_fee` when the fee is stored only on the delivery row. |

Fee resolution (first **non-zero** amount wins): `card_fee` → `service_fee` → `convenience_fee` → `platform_fee` → `application_fee` → `packaging_fee` → other JSON hints → `mt_order_delivery_address.service_fee`. Values are also read from **`mt_order.json_details`** when present (shallow + nested keys like `cart`, `totals`, `order`).

## List vs detail

Both endpoints now merge the same payment scalars onto the **task root** and nested `order`/`mt_order`, and list rows use the **latest** `mt_order_delivery_address` row per order (same as detail) so fees are not dropped on `GetTaskByDate`.

## Example (redacted) `GetTaskDetails` payload shape

```json
{
  "code": 1,
  "msg": "OK",
  "details": {
    "task_id": 12345,
    "order_id": 9876,
    "order_total_amount": "450.00",
    "sub_total": "350.00",
    "total_w_tax": "450.00",
    "convenience_fee": "25.00",
    "convenienceFee": "25.00",
    "service_fee": "25.00",
    "delivery_charge": "50.00",
    "cart_tip_value": "25.00",
    "mt_order": {
      "sub_total": "350.00",
      "total_w_tax": "450.00",
      "service_fee": "25.00",
      "convenience_fee": "25.00",
      "delivery_charge": "50.00"
    },
    "mt_order_delivery_address": {
      "street": "…",
      "service_fee": "25.00"
    }
  }
}
```

Implementation: `WIB-Rider-Backend/routes/driver.js` — `computeMtOrderPaymentFieldsForDriver`, `attachScheduleLinesAndAliases`, `batchFetchLatestDeliveryAddressesByOrderIds`.
