# Lago request/response fixtures

Bytes literales que Numaris Billing envía a Lago, junto con las responses
reales devueltas por Lago Cloud. Capturados el 12-may-2026 contra el
customer `carga-express-mx`.

## Convención de nombres

```
NN[a-z]?-<endpoint>.request.json     # body que Numaris envía
NN[a-z]?-<endpoint>.response.json    # response de Lago Cloud
NN[a-z]?-<endpoint>.url.txt          # path + query para GETs (sin body)
```

| #   | Endpoint                                                | Fase |
| --- | ------------------------------------------------------- | ---- |
| 01a | `POST /customers` (create)                              |  1   |
| 01b | `POST /customers` (upsert, mismo external_id)           |  1   |
| 02  | `GET /customers/:external_id`                           |  1   |
| 03  | `POST /taxes`                                           |  1   |
| 04  | `POST /events` (operation_type:"add")                   |  2   |
| 05  | `POST /events` (operation_type:"remove")                |  2   |
| 06  | `POST /plans` con `prorated:true`                       |  2   |
| 07a | `POST /subscriptions` con `billing_time:"anniversary"`  |  2   |
| 07b | `POST /subscriptions` con `billing_time:"calendar"`     |  2   |
| 08  | `GET /current_usage?apply_taxes=false`                  |  2   |

## Uso desde tests

Los fixtures se ejercitan en `tests/integration/fixture-replay.test.ts`,
que POSTea los bytes literales contra mini-lago y compara la response
field-by-field, ignorando los campos volátiles
(`lago_id`, `created_at`, `updated_at`, `sequential_id`, `slug`).
