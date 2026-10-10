# Procurement

P1 = needed for the Phase 1 bench build. P2 = the finished cylinder. Bench = setup convenience, not part of the device.

## Ordered (10 Oct 2026)

| Supplier | Item | Qty | Price | Phase | Status |
|---|---|---|---|---|---|
| The Pi Hut | Raspberry Pi 5 8GB | 1 | £168.00 | P1 | ordered |
| The Pi Hut | reSpeaker Flex XVF3800, Circular, with XIAO ESP32S3 | 1 | £58.50 | P1 | ordered (ships I2S firmware, reflash needed) |
| The Pi Hut | Active Cooler for Raspberry Pi 5 | 1 | £4.80 | P1 | ordered |
| The Pi Hut | Raspberry Pi 27 W USB-C PSU, UK, black | 1 | £11.50 | P1 | ordered |
| The Pi Hut | USB-A to USB-C cable, black, 15 cm | 1 | £2.25 | P1 | ordered (Pi ↔ Flex XMOS port) |
| The Pi Hut | Black nylon screw and stand-off set, M3 | 1 | £16.30 | P1 | ordered (mic board and core board mounts) |
| The Pi Hut | JST PH 2-pin cable, male header, 200 mm | 3 | £2.40 | P1 | ordered; **probably doesn't mate with the Flex speaker header** (it mates with female plugs). Cut the plug off and use the leads on the solder pad |
| The Pi Hut | Raspberry Pi micro-HDMI cable, 2 m, black | 1 | £5.80 | Bench | ordered |
| The Pi Hut | Raspberry Pi USB 3 Hub | 1 | £11.50 | Bench | ordered (keyboard during setup; not inside the cylinder) |
| RS Components | Visaton R 10 S 4 Ω (stock no. 431-8440) | 1 | £20.01 + £9.50 delivery, £29.51 ex VAT | P1 | due 13 Oct 2026 |
| Amazon (Electrolyx UK) | SanDisk High Endurance microSD 256 GB + adapter | 1 | see order | P1 | ordered; marketplace seller, **verify with `f3`** |
| Amazon (AnkerDirect UK) | Anker 2-in-1 USB-C card reader | 1 | see order | Bench | ordered |

The Pi Hut items total £281.05 before delivery.

Owned from the LetterBox project: Miniware TS21 soldering iron, solder, stand, tip cleaner, PCB vice, flux pen, jumper wires, Nordic PPK2.

## Still to buy

### Phase 1 (bench)

| Item | Where | Price | Why |
|---|---|---|---|
| Heat-shrink assortment | Amazon UK, not checked | ~£5 | Speaker tab joints |
| Temporary test box (MDF offcut or sealed cardboard box) | anywhere | ~£0 | Never run the R 10 S hard unbaffled |

Nothing else blocks Phase 1. Rough frequency sweeps can use the Flex's raw mic channel (ch2); a calibrated USB measurement mic (miniDSP UMIK-1 class, ~£100) is optional for the EQ.

### Phase 2 (cylinder)

| Item | Where | Price | Why |
|---|---|---|---|
| Raspberry Pi M.2 HAT+ | [The Pi Hut](https://thepihut.com/products/raspberry-pi-m2-hat-plus) | £11.50, in stock 10 Oct 2026 | NVMe on top of the Pi, fits with the Active Cooler (16 mm stacking header included) |
| Raspberry Pi SSD 256 GB | [The Pi Hut](https://thepihut.com/products/raspberry-pi-ssd) | £57.60 | **Sold out at The Pi Hut, Pimoroni and Farnell (10 Oct 2026).** Notify-me set; buy when back |
| PETG print of the cylinder parts | JLC3DP / Craftcloud, quote needed | not checked | Enclosure; PETG not PLA (heat) |
| Panel-mount USB-C extension, **5 A e-marked, PD pass-through** | not checked | not checked | Rear power inlet. A cable that breaks USB PD drops the Pi to 3 A mode and a 600 mA USB limit, which browns out the Flex |
| Acoustic grille cloth | not checked | ~£10 | Over the mic cap and the base gap |
| Closed-cell foam sheet, 1 to 2 mm, self-adhesive | not checked | ~£6 | Mic port gaskets, driver gasket, divider gasket |
| Polyester wadding (acoustic fibre) | not checked | ~£5 | Speaker chamber damping |
| M3 brass heat-set inserts | not checked | ~£8 | Fixings into PETG (set with the TS21) |
| Driver screws | measure the R 10 S frame holes first | ~£3 | Mount the driver to the bottom baffle |
| Ethernet cable (optional) | anywhere | ~£3 | Lower jitter than Wi-Fi; keeps 2.4 GHz free if the XIAO radiates |
| Momentary push button (optional) | not checked | ~£2 | Hardware mute input on a Pi GPIO |

## Rules for new parts

- Check UK stock and lead time on the product page itself on the day; quote that supplier's price only.
- If something is sold out everywhere, say so first and offer the fallback.

## Price sources (checked 10 Oct 2026)

- The Pi Hut product pages (Shopify `.js` endpoints for stock), RS UK product page 431-8440, Farnell UK (SC1675 "No Longer Manufactured", SC1439 "No Longer Stocked"), Pimoroni (Raspberry Pi SSD out of stock), Scan UK SSD listings.
