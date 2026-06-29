/* ============================================================
   REGNUM AETERNUM — Land Registry System
   Offline/no-backend fallback. Loaded as a plain script so the
   search page, record view, and cadastral map all still work when
   opened directly from disk or if /api/landregistry/data can't be
   reached — same role legal/assets/legal-data.js plays for the
   Legal Information System.

   Mirrored from the seed rows in migrations/0004_land_registry.sql —
   keep the two in agreement if you add a worked example to one.
   ============================================================ */

(function () {
  "use strict";

  var divisions = [
    { code: "RA1M", name: "Ardoritha" },
    { code: "RA2V", name: "Vinland" },
    { code: "RA3D", name: "Meridia" },
    { code: "RA4L", name: "Littoria" },
    { code: "RA5A", name: "Algiers" }
  ];

  var plots = [
    {
      registerNumber: "RA1M/00000001/7", divisionCode: "RA1M", bookNumber: "00000001", controlDigit: "7",
      world: "world", owner: "Liora Ashgrove", resident: "Liora Ashgrove", isRented: false,
      yLower: 63, yUpper: 80, status: "registered",
      corners: [{ x: 120, z: 340 }, { x: 136, z: 340 }, { x: 136, z: 356 }, { x: 120, z: 356 }],
      plotType: "residential", renter: "", rentAmount: 0, rentCurrency: "", rentDueDate: "",
      registeredDate: "2025-04-11",
      notes: "Timber cottage and kitchen garden near the Ardoritha market square."
    },
    {
      registerNumber: "RA2V/00000014/3", divisionCode: "RA2V", bookNumber: "00000014", controlDigit: "3",
      world: "world", owner: "Mireille Costanza", resident: "Tobias Wren", isRented: true,
      yLower: 63, yUpper: 90, status: "registered",
      corners: [{ x: -220, z: 58 }, { x: -196, z: 58 }, { x: -196, z: 82 }, { x: -220, z: 82 }],
      plotType: "commercial", renter: "Tobias Wren", rentAmount: 40, rentCurrency: "crowns", rentDueDate: "2026-07-01",
      registeredDate: "2025-09-02",
      notes: "The Salt Anchor tavern, let to its current keeper on a standing lease."
    },
    {
      registerNumber: "RA3D/00000005/1", divisionCode: "RA3D", bookNumber: "00000005", controlDigit: "1",
      world: "world", owner: "Hendrick Vass", resident: "Hendrick Vass", isRented: false,
      yLower: 50, yUpper: 62, status: "registered",
      corners: [{ x: 400, z: 120 }, { x: 416, z: 120 }, { x: 416, z: 136 }, { x: 400, z: 136 }],
      plotType: "storage", renter: "", rentAmount: 0, rentCurrency: "", rentDueDate: "",
      registeredDate: "2025-11-19",
      notes: "Sealed cellar vault beneath the Meridia bookbindery. Same footprint as RA3D/00000005/2, one level down."
    },
    {
      registerNumber: "RA3D/00000005/2", divisionCode: "RA3D", bookNumber: "00000005", controlDigit: "2",
      world: "world", owner: "Hendrick Vass", resident: "Hendrick Vass", isRented: false,
      yLower: 63, yUpper: 85, status: "registered",
      corners: [{ x: 400, z: 120 }, { x: 416, z: 120 }, { x: 416, z: 136 }, { x: 400, z: 136 }],
      plotType: "commercial", renter: "", rentAmount: 0, rentCurrency: "", rentDueDate: "",
      registeredDate: "2025-11-19",
      notes: "Meridia bookbindery and the owner's upstairs apartment. Built directly over the vault at RA3D/00000005/1 \u2014 the map shows this one in its flat view since it is the topmost of the pair."
    },
    {
      registerNumber: "RA4L/00000002/0", divisionCode: "RA4L", bookNumber: "00000002", controlDigit: "0",
      world: "world", owner: "", resident: "", isRented: false,
      yLower: 62, yUpper: 78, status: "vacant",
      corners: [{ x: -60, z: -410 }, { x: -40, z: -410 }, { x: -40, z: -392 }, { x: -60, z: -392 }],
      plotType: "vacant", renter: "", rentAmount: 0, rentCurrency: "", rentDueDate: "",
      registeredDate: "2026-01-30",
      notes: "Cleared harbourside lot, surveyed but not yet claimed."
    },
    {
      registerNumber: "RA5A/00000010/5", divisionCode: "RA5A", bookNumber: "00000010", controlDigit: "5",
      world: "world", owner: "Order of the Sandwrought Vine", resident: "Order of the Sandwrought Vine", isRented: false,
      yLower: 61, yUpper: 70, status: "registered",
      corners: [{ x: 610, z: -140 }, { x: 660, z: -140 }, { x: 660, z: -96 }, { x: 610, z: -96 }],
      plotType: "agricultural", renter: "", rentAmount: 0, rentCurrency: "", rentDueDate: "",
      registeredDate: "2025-07-08",
      notes: "Terraced vineyard held in common by the Order. Boundary follows the old irrigation ditch, not a chunk grid."
    }
  ];

  window.LAND_REGISTRY_DATA = { divisions: divisions, plots: plots };
})();
