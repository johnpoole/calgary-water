export class RiskConsequenceModel {
  constructor({ currentYear = new Date().getFullYear() } = {}) {
    this.currentYear = currentYear;
    this.riskLabels = ["Low", "Medium", "High", "Very High"];
  }

  clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  riskPaletteN(n = 4) {
    const nn = this.clamp(Math.round(Number(n) || 4), 2, 11);
    // D3 interpolator runs red->green; reverse so Low->green, High->red.
    const cols = typeof d3.quantize === "function" && d3.interpolateRdYlGn
      ? d3.quantize(d3.interpolateRdYlGn, nn)
      : (d3.schemeRdYlGn?.[nn] ?? []);
    // Ensure array and correct direction.
    const arr = Array.isArray(cols) ? cols.slice() : [];
    return arr.reverse();
  }

  riskPalette() {
    return this.riskPaletteN(4);
  }

  consequencePalette() {
    const base =
      d3.schemeBlues?.[5] ?? ["#eff6ff", "#bfdbfe", "#60a5fa", "#2563eb", "#1e3a8a"];
    return [base[1], base[2], base[3], base[4]];
  }

  normalizeMaterial(raw) {
    const s = (raw ?? "").toString().trim().toUpperCase();
    if (!s) return "Unknown";

    // Dataset normalization / aliases.
    // The Calgary mains layer uses CON="Concrete" for large concrete mains that
    // align with the PCCP/PCI evidence base in our docs; treat CON as PCCP for
    // scoring so the 1970s PCCP vintage rule applies.
    if (s === "CON") return "PCCP";

    // Common textual variants.
    if (s === "COPPER") return "CU";
    return s;
  }

  parseInstallYear(raw) {
    const s = (raw ?? "").toString();
    const m = s.match(/\b(18|19|20)\d{2}\b/);
    if (!m) return null;
    const y = Number(m[0]);
    if (!Number.isFinite(y) || y < 1800 || y > this.currentYear) return null;
    return y;
  }

  ageYears(installYear) {
    if (installYear == null) return null;
    const a = this.currentYear - installYear;
    return a >= 0 ? a : null;
  }

  pofSizeUpliftFrom({ materialCode, diamMm } = {}) {
    // Conservative size effect: smaller distribution-size metallic/brittle mains
    // experience higher observed break rates than larger diameters.
    // Returns a float uplift in the same 1..4 scale used before rounding.
    const mat = this.normalizeMaterial(materialCode);
    if (typeof diamMm !== "number" || !Number.isFinite(diamMm)) return 0;
    const sizeSensitive =
      mat === "DI" ||
      mat === "PDI" ||
      mat === "YDI" ||
      mat === "ST" ||
      mat === "STEEL" ||
      mat === "CI" ||
      mat === "AC";
    if (!sizeSensitive) return 0;
    if (diamMm <= 150) return 1.0;
    if (diamMm <= 305) return 0.5;
    return 0;
  }

  pofScoreFrom({ materialCode, installYear, diamMm } = {}) {
    // PoF proxy based on the qualitative guidance in
    // docs/Pipe_Risk_Assessment_Water_Mains_North_America.docx.
    const mat = this.normalizeMaterial(materialCode);
    const iy = installYear ?? null;
    const age = this.ageYears(iy);
    // Base likelihood by material class (1..4)
    // Low: PVC/PE/HDPE/PCCP; Moderate: DI/Steel; High: CI/AC.
    const baseByMaterial = new Map([
      ["PVC", 1],
      ["PE", 1],
      ["HDPE", 1],
      ["DI", 2],
      ["PDI", 2],
      ["YDI", 2],
      ["ST", 2],
      ["STEEL", 2],
      ["CI", 3],
      ["AC", 3],
      // This dataset uses PCI for PCCP in places; treat it as PCCP.
      // PCCP failures are often driven by age-related distress (wire break, corrosion,
      // coating loss) and can become more likely as the asset ages; we therefore do
      // not treat PCCP as "low likelihood" by default.
      ["PCI", 2],
      ["PCCP", 2],
      ["CU", 2],
      ["COPPER", 2],
    ]);

    let score = baseByMaterial.get(mat) ?? 2;

    // Size effect (conservative): break rates generally decrease as diameter increases.
    // Source alignment: USU/Barfuss (2023) summarizes lower break rates in larger diameters,
    // with distribution (<=12") failing much more often than transmission mains.
    // We only apply this to metallic/brittle materials; plastics already have low LoF here.
    score += this.pofSizeUpliftFrom({ materialCode: mat, diamMm });

    // Age/vintage adjustments (explicit ranges).
    // - CI & AC older than 50 years: elevated likelihood.
    // - AC near/over 50 years: treat as approaching end-of-life (stronger bump).
    if (typeof age === "number" && Number.isFinite(age)) {
      if (mat === "CI" && age > 50) score += 1;
      if (mat === "AC" && age > 50) score += 2;

      // PCCP / PCI: older assets are more likely to exhibit distress.
      // Keep this as a floor so we don't over-amplify for already-high vintages.
      if (mat === "PCI" || mat === "PCCP") {
        if (age >= 50) score = Math.max(score, 4);
        else if (age >= 40) score = Math.max(score, 3);
      }
    }

    // PCCP / PCI vintage-specific likelihood.
    // - 1972–1978: highest likelihood.
    // - Other 1970–1980: elevated likelihood.
    // Note: we do not have a reliable per-segment "Class IV wire" flag in the dataset,
    // so installation year is used as the proxy for these published vintage ranges.
    if (iy != null && (mat === "PCI" || mat === "PCCP")) {
      if (iy >= 1972 && iy <= 1978) score = Math.max(score, 4);
      else if (iy >= 1970 && iy <= 1980) score = Math.max(score, 3);
    }

    return this.clamp(Math.round(score), 1, 4);
  }

  consequenceScoreFrom({ materialCode, diamMm, lengthM } = {}) {
    // CoF proxy: diameter-driven with material overrides from the doc.
    let score = 2;

    if (typeof diamMm === "number" && Number.isFinite(diamMm)) {
      if (diamMm <= 150) score = 1;
      else if (diamMm <= 250) score = 2;
      else if (diamMm <= 400) score = 3;
      else score = 4;
    }

    const mat = this.normalizeMaterial(materialCode);

    // Material-based consequence hints:
    // - PCCP is described as Very High consequence.
    // - Steel can be High for large-diameter transmission mains.
    // - Copper is Low (typically services/small).
    if (mat === "PCI" || mat === "PCCP") score = Math.max(score, 4);
    if (mat === "ST" && (typeof diamMm === "number" && diamMm >= 400)) score = Math.max(score, 3);
    if (mat === "CU") score = Math.min(score, 1);

    // Small bump for very long segments.
    if (typeof lengthM === "number" && Number.isFinite(lengthM) && lengthM >= 500) {
      score += 1;
    }

    return this.clamp(Math.round(score), 1, 4);
  }

  riskBinFromScores(pof, cof) {
    const product = (pof ?? 2) * (cof ?? 2);
    if (product <= 4) return 1;
    if (product <= 8) return 2;
    if (product <= 12) return 3;
    return 4;
  }

  scoreFromFloat01to4(x) {
    // Convert a 1..~5 float score (e.g., road uplift adds 0.5 increments)
    // into our 1..4 discrete level.
    if (typeof x !== "number" || !Number.isFinite(x)) return null;
    if (x <= 2.0) return 1;
    if (x <= 3.0) return 2;
    if (x <= 4.0) return 3;
    return 4;
  }

  compute({ materialCode, diamMm, installYear, lengthM } = {}) {
    const pof = this.pofScoreFrom({ materialCode, installYear, diamMm });
    const cof = this.consequenceScoreFrom({ materialCode, diamMm, lengthM });
    const riskBin = this.riskBinFromScores(pof, cof);
    return {
      pof,
      cof,
      pofFloat: pof,
      cofFloat: cof,
      riskBin,
      source: "doc",
      pofSource: "doc",
      cofSource: "doc",
      pofSizeUplift: this.pofSizeUpliftFrom({ materialCode, diamMm }),
    };
  }

  explain({ materialCode, diamMm, installYear, lengthM } = {}) {
    const rawMat = (materialCode ?? "").toString().trim().toUpperCase() || null;
    const mat = this.normalizeMaterial(materialCode);
    const iy = installYear ?? null;
    const age = this.ageYears(iy);

    // --- PoF breakdown ---
    const baseByMaterial = new Map([
      ["PVC", 1],
      ["PE", 1],
      ["HDPE", 1],
      ["DI", 2],
      ["PDI", 2],
      ["YDI", 2],
      ["ST", 2],
      ["STEEL", 2],
      ["CI", 3],
      ["AC", 3],
      ["PCI", 2],
      ["PCCP", 2],
      ["CU", 2],
      ["COPPER", 2],
    ]);

    const pofBaseMaterial = baseByMaterial.get(mat) ?? 2;
    const pofSizeUplift = this.pofSizeUpliftFrom({ materialCode: mat, diamMm });

    let pofAgeUplift = 0;
    if (typeof age === "number" && Number.isFinite(age)) {
      if (mat === "CI" && age > 50) pofAgeUplift += 1;
      if (mat === "AC" && age > 50) pofAgeUplift += 2;
    }

    let pofPccpAgeFloor = null;
    if (typeof age === "number" && Number.isFinite(age) && (mat === "PCI" || mat === "PCCP")) {
      if (age >= 50) pofPccpAgeFloor = 4;
      else if (age >= 40) pofPccpAgeFloor = 3;
    }

    const pofPreVintage = pofBaseMaterial + pofSizeUplift + pofAgeUplift;
    let pofVintageFloor = null;
    if (iy != null && (mat === "PCI" || mat === "PCCP")) {
      if (iy >= 1972 && iy <= 1978) pofVintageFloor = 4;
      else if (iy >= 1970 && iy <= 1980) pofVintageFloor = 3;
    }

    let pofPreRound = pofPreVintage;
    if (typeof pofPccpAgeFloor === "number" && Number.isFinite(pofPccpAgeFloor)) {
      pofPreRound = Math.max(pofPreRound, pofPccpAgeFloor);
    }
    if (typeof pofVintageFloor === "number" && Number.isFinite(pofVintageFloor)) {
      pofPreRound = Math.max(pofPreRound, pofVintageFloor);
    }

    const pof = this.pofScoreFrom({ materialCode: mat, installYear: iy, diamMm });

    // --- CoF breakdown ---
    let cofDiamScore = null;
    let cofScore = 2;

    if (typeof diamMm === "number" && Number.isFinite(diamMm)) {
      if (diamMm <= 150) cofScore = 1;
      else if (diamMm <= 250) cofScore = 2;
      else if (diamMm <= 400) cofScore = 3;
      else cofScore = 4;
      cofDiamScore = cofScore;
    }

    let cofMaterialHint = null;
    if (mat === "PCI" || mat === "PCCP") {
      cofMaterialHint = { type: "floor", value: 4 };
      cofScore = Math.max(cofScore, 4);
    }
    if (mat === "ST" && (typeof diamMm === "number" && Number.isFinite(diamMm) && diamMm >= 400)) {
      cofMaterialHint = { type: "floor", value: 3 };
      cofScore = Math.max(cofScore, 3);
    }
    if (mat === "CU") {
      cofMaterialHint = { type: "cap", value: 1 };
      cofScore = Math.min(cofScore, 1);
    }

    const cofLengthUplift =
      typeof lengthM === "number" && Number.isFinite(lengthM) && lengthM >= 500 ? 1 : 0;
    const cofPreRound = cofScore + cofLengthUplift;
    const cof = this.consequenceScoreFrom({ materialCode: mat, diamMm, lengthM });

    const product = (pof ?? 2) * (cof ?? 2);
    const riskBin = this.riskBinFromScores(pof, cof);
    const riskLabel = this.riskLabels[(riskBin ?? 1) - 1] ?? null;

    return {
      inputs: {
        materialCodeRaw: rawMat,
        materialCode: mat,
        diamMm: typeof diamMm === "number" && Number.isFinite(diamMm) ? diamMm : null,
        installYear: typeof iy === "number" && Number.isFinite(iy) ? iy : null,
        ageYears: typeof age === "number" && Number.isFinite(age) ? age : null,
        lengthM: typeof lengthM === "number" && Number.isFinite(lengthM) ? lengthM : null,
      },
      pof: {
        baseMaterial: pofBaseMaterial,
        sizeUplift: pofSizeUplift,
        ageUplift: pofAgeUplift,
        pccpAgeFloor: pofPccpAgeFloor,
        vintageFloor: pofVintageFloor,
        preRound: pofPreRound,
        level: pof,
      },
      cof: {
        diamScore: cofDiamScore,
        materialHint: cofMaterialHint,
        lengthUplift: cofLengthUplift,
        preRound: cofPreRound,
        level: cof,
      },
      risk: {
        product,
        riskBin,
        riskLabel,
      },
      formula: {
        pof: "PoF = clamp(round(max(baseMaterial + sizeUplift + ageUplift, pccpAgeFloor?, vintageFloor?)), 1, 4)",
        cof: "CoF = clamp(round((diameterScore or 2) with material hints + lengthUplift), 1, 4)",
        risk: "RiskClass = bin(PoF × CoF): <=4→1, <=8→2, <=12→3, else→4",
      },
      source: "doc",
    };
  }
}
