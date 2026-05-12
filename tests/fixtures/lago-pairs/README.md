# Lago request/response fixtures

Pares request/response **canónicos del mini-Lago self-hosted**. La fuente
inicial son capturas de Lago Cloud (12-may-2026, customer
`carga-express-mx`), pero donde Lago Cloud diverge del comportamiento
deseado (premium gates, fields silenciados, shapes deprecados) los
fixtures reflejan el **comportamiento mini-Lago**, no el de Lago Cloud.

## Convención de archivos

```
NN[a-z]?-<endpoint>.request.json              # body que envía el cliente
NN[a-z]?-<endpoint>.response.json             # response canónica mini-Lago
NN[a-z]?-<endpoint>.response.synthetic.json   # response sintética (ver abajo)
NN[a-z]?-<endpoint>.url.txt                   # path + query para GETs
```

| #   | Endpoint                                                       | Fase |
| --- | -------------------------------------------------------------- | ---- |
| 01a | `POST /customers` (create)                                     |  1   |
| 01b | `POST /customers` (upsert)                                     |  1   |
| 02  | `GET /customers/:external_id`                                  |  1   |
| 03  | `POST /taxes`                                                  |  1   |
| 04  | `POST /events` (operation_type:"add")                          |  2   |
| 05  | `POST /events` (operation_type:"remove")                       |  2   |
| 06  | `POST /plans` con `prorated:true`                              |  2   |
| 07a | `POST /subscriptions` con `billing_time:"anniversary"`         |  2   |
| 07b | `POST /subscriptions` con `billing_time:"calendar"`            |  2   |
| 08  | `GET /current_usage?apply_taxes=false`                         |  2   |
| 09a | `POST /add_ons` (mensual)                                      |  2   |
| 09b | `POST /add_ons` (setup)                                        |  2   |
| 10  | `GET /add_ons/:code`                                           |  2   |
| 11  | `POST /invoices` con `fees: [{ add_on_code, ... }]`            |  3   |
| 12  | `POST /credit_notes` con `items: [{ fee_id, ... }]`            |  3   |

## Fixtures sintéticos (`*.response.synthetic.json`)

Algunos endpoints están premium-gated en Lago Cloud free tier (responden
`403 feature_unavailable`) y por lo tanto no se pueden capturar contra
producción. Para esos pares el archivo se llama
`*.response.synthetic.json` y su shape está derivado de:

1. Los TS types del SDK `lago-javascript-client@1.46.1`.
2. El código real de Numaris que consume cada campo.

El primer campo del JSON sintético es siempre `"_synthetic"` con la
justificación. **El mini-Lago NO replica los premium gates** — debe
responder con el shape sintético sin restricciones.

| Par | Premium gate en Lago Cloud | Decisión mini-Lago |
| --- | --- | --- |
| 12  | `POST /credit_notes` → 403 | Sin gating (D5). |

## Divergencias mini-Lago vs Lago Cloud reflejadas en fixtures

| Tema | Lago Cloud (captured) | Mini-Lago canonical |
| --- | --- | --- |
| `customer.metadata` | array `[]` o `[{key,value,...}]` | objeto `{}` (D3) |
| `customer.timezone` | `null` (silenciado por premium) | persistido literal (D4) |
| `customer.applicable_timezone` | siempre `"UTC"` (premium gate) | cascade `customer.tz || org.tz || "UTC"` (D4) |
| `credit_notes` | 403 free tier | shape sintético, sin gating (D5) |

## Uso desde tests

`tests/integration/fixture-replay.test.ts` POSTea los request fixtures
contra mini-Lago y diffea field-by-field, ignorando volátiles
(`lago_id`, `created_at`, `sequential_id`, `slug`, etc.).
