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

  pofDiameterAdjustmentFrom({ materialCode, diamMm } = {}) {
    // Doc-aligned, conservative diameter effect: distribution-size metallic/brittle
    // mains break more often than large transmission mains.
    // Returns a float adjustment in the same 1..4 scoring space (pre-round).
    const mat = this.normalizeMaterial(materialCode);
    if (typeof diamMm !== "number" || !Number.isFinite(diamMm)) return 0;

    const diameterSensitive =
      mat === "CI" ||
      mat === "AC" ||
      mat === "DI" ||
      mat === "PDI" ||
      mat === "YDI" ||
      mat === "ST" ||
      mat === "STEEL";
    if (!diameterSensitive) return 0;

    if (diamMm <= 150) return 1.0;
    if (diamMm <= 305) return 0.5;
    return 0;
  }

  pofMaterialBaseFrom({ materialCode } = {}) {
    // Based on docs/Pipe_Risk_Assessment_Water_Mains_North_America.txt
    // Levels: 1=Low, 2=Moderate, 3=High, 4=Very High
    const mat = this.normalizeMaterial(materialCode);

    if (mat === "PVC" || mat === "PE" || mat === "HDPE") return 1;
    if (mat === "PCCP" || mat === "PCI") return 1;

    if (mat === "DI" || mat === "PDI" || mat === "YDI") return 2;
    if (mat === "ST" || mat === "STEEL") return 2;
    if (mat === "CU") return 2;

    if (mat === "CI") return 3;
    if (mat === "AC") return 3;

    return 2;
  }

  pofAgeAdjustmentFrom({ materialCode, ageYears } = {}) {
    // Based on docs/Pipe_Risk_Assessment_Water_Mains_North_America.txt
    const mat = this.normalizeMaterial(materialCode);
    if (typeof ageYears !== "number" || !Number.isFinite(ageYears)) return 0;

    // CI and AC show materially higher break likelihood in older cohorts.
    if (mat === "CI" && ageYears > 50) return 1;
    if (mat === "AC" && ageYears > 50) return 1;

    return 0;
  }

  pofVintageOverrideFrom({ materialCode, installYear } = {}) {
    // Based on docs/Pipe_Risk_Assessment_Water_Mains_North_America.txt
    // PCCP vintage: elevated in ~1970–1980, with the most problematic cohort
    // particularly noted in 1975–1978.
    const mat = this.normalizeMaterial(materialCode);
    const y = typeof installYear === "number" && Number.isFinite(installYear) ? installYear : null;
    if (y == null) return null;
    if (!(mat === "PCCP" || mat === "PCI")) return null;

    if (y >= 1975 && y <= 1978) return 4;
    if (y >= 1970 && y <= 1980) return 3;
    return null;
  }

  scoreFromFloat1to4(x) {
    if (typeof x !== "number" || !Number.isFinite(x)) return null;
    return this.clamp(Math.round(x), 1, 4);
  }

  pofScoreFrom({ materialCode, installYear, diamMm } = {}) {
    const mat = this.normalizeMaterial(materialCode);
    const iy = typeof installYear === "number" && Number.isFinite(installYear) ? installYear : null;
    const age = this.ageYears(iy);

    const vintageOverride = this.pofVintageOverrideFrom({ materialCode: mat, installYear: iy });
    if (typeof vintageOverride === "number" && Number.isFinite(vintageOverride)) {
      return this.clamp(vintageOverride, 1, 4);
    }

    const base = this.pofMaterialBaseFrom({ materialCode: mat });
    const diamAdj = this.pofDiameterAdjustmentFrom({ materialCode: mat, diamMm });
    const ageAdj = this.pofAgeAdjustmentFrom({ materialCode: mat, ageYears: age });
    const preRound = base + diamAdj + ageAdj;

    return this.scoreFromFloat1to4(preRound) ?? this.clamp(base, 1, 4);
  }

  consequenceScoreFrom({ materialCode, diamMm, lengthM } = {}) {
    // CoF proxy: diameter-driven with doc-backed material adjustments.
    // (We intentionally do not add extra factors like length unless explicitly sourced.)
    let score = 2;
    let diamScore = null;
    if (typeof diamMm === "number" && Number.isFinite(diamMm)) {
      if (diamMm <= 150) score = 1;
      else if (diamMm <= 250) score = 2;
      else if (diamMm <= 400) score = 3;
      else score = 4;
      diamScore = score;
    }

    const mat = this.normalizeMaterial(materialCode);

    // PCCP trunk mains: catastrophic consequence.
    if (mat === "PCI" || mat === "PCCP") score = 4;

    // Steel: High for large-diameter transmission mains.
    if ((mat === "ST" || mat === "STEEL") && (typeof diamMm === "number" && Number.isFinite(diamMm) && diamMm >= 400)) {
      score = Math.max(score, 4);
    }

    // Copper: small service-like assets.
    if (mat === "CU") score = Math.min(score, 1);

    // AC: hydraulic consequence may be low/moderate, but repair handling costs/constraints are higher.
    if (mat === "AC") score = Math.max(score, 2);

    // PVC/HDPE: low to moderate consequence.
    if (mat === "PVC" || mat === "PE" || mat === "HDPE") score = Math.min(score, 3);

    // CI/DI are described as moderate consequence in the summary doc.
    if (mat === "CI" || mat === "DI" || mat === "PDI" || mat === "YDI") score = Math.max(score, 2);

    return this.scoreFromFloat1to4(score) ?? (diamScore != null ? this.clamp(diamScore, 1, 4) : 2);
  }

  riskBinFromScores(pof, cof) {
    const product = (pof ?? 2) * (cof ?? 2);
    if (product <= 4) return 1;
    if (product <= 8) return 2;
    if (product <= 12) return 3;
    return 4;
  }

  scoreFromFloat01to4(x) {
    // Backwards-compatible alias used by the roads adjustment code.
    return this.scoreFromFloat1to4(x);
  }

  compute({ materialCode, diamMm, installYear, lengthM } = {}) {
    const mat = this.normalizeMaterial(materialCode);
    const iy = typeof installYear === "number" && Number.isFinite(installYear) ? installYear : null;
    const age = this.ageYears(iy);

    const pofVintageOverride = this.pofVintageOverrideFrom({ materialCode: mat, installYear: iy });
    const pofBaseMaterial = this.pofMaterialBaseFrom({ materialCode: mat });
    const pofDiamAdj = this.pofDiameterAdjustmentFrom({ materialCode: mat, diamMm });
    const pofAgeAdj = this.pofAgeAdjustmentFrom({ materialCode: mat, ageYears: age });
    const pofPreRound =
      typeof pofVintageOverride === "number" && Number.isFinite(pofVintageOverride)
        ? pofVintageOverride
        : pofBaseMaterial + pofDiamAdj + pofAgeAdj;
    const pof =
      typeof pofVintageOverride === "number" && Number.isFinite(pofVintageOverride)
        ? this.clamp(pofVintageOverride, 1, 4)
        : (this.scoreFromFloat1to4(pofPreRound) ?? this.clamp(pofBaseMaterial, 1, 4));

    const cof = this.consequenceScoreFrom({ materialCode: mat, diamMm, lengthM });
    const riskBin = this.riskBinFromScores(pof, cof);
    return {
      pof,
      cof,
      pofFloat: pofPreRound,
      cofFloat: cof,
      riskBin,
      source: "doc",
      pofSource: "doc",
      cofSource: "doc",
      pofDiameterAdjustment: pofDiamAdj,
      pofVintageOverride,
    };
  }

  explain({ materialCode, diamMm, installYear, lengthM } = {}) {
    const rawMat = (materialCode ?? "").toString().trim().toUpperCase() || null;
    const mat = this.normalizeMaterial(materialCode);
    const iy = installYear ?? null;
    const age = this.ageYears(iy);

    // --- PoF breakdown (explicit scorecard) ---
    const pofBaseMaterial = this.pofMaterialBaseFrom({ materialCode: mat });
    const pofDiamAdj = this.pofDiameterAdjustmentFrom({ materialCode: mat, diamMm });
    const pofAgeAdj = this.pofAgeAdjustmentFrom({ materialCode: mat, ageYears: age });
    const pofVintageOverride = this.pofVintageOverrideFrom({ materialCode: mat, installYear: iy });

    const pofPreRound =
      typeof pofVintageOverride === "number" && Number.isFinite(pofVintageOverride)
        ? pofVintageOverride
        : pofBaseMaterial + pofDiamAdj + pofAgeAdj;
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

    const cofMaterialAdjustments = [];
    if (mat === "PCI" || mat === "PCCP") {
      cofMaterialAdjustments.push({ type: "set", value: 4, reason: "PCCP trunk main consequence" });
      cofScore = 4;
    }
    if ((mat === "ST" || mat === "STEEL") && (typeof diamMm === "number" && Number.isFinite(diamMm) && diamMm >= 400)) {
      cofMaterialAdjustments.push({ type: "floor", value: 4, reason: "Large-diameter steel transmission" });
      cofScore = Math.max(cofScore, 4);
    }
    if (mat === "CU") {
      cofMaterialAdjustments.push({ type: "cap", value: 1, reason: "Copper is typically small diameter" });
      cofScore = Math.min(cofScore, 1);
    }
    if (mat === "AC") {
      cofMaterialAdjustments.push({ type: "floor", value: 2, reason: "AC repair/handling complexity" });
      cofScore = Math.max(cofScore, 2);
    }
    if (mat === "PVC" || mat === "PE" || mat === "HDPE") {
      cofMaterialAdjustments.push({ type: "cap", value: 3, reason: "Plastic consequence is low-to-moderate" });
      cofScore = Math.min(cofScore, 3);
    }
    if (mat === "CI" || mat === "DI" || mat === "PDI" || mat === "YDI") {
      cofMaterialAdjustments.push({ type: "floor", value: 2, reason: "CI/DI consequence is moderate" });
      cofScore = Math.max(cofScore, 2);
    }

    const cofPreRound = cofScore;
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
        diameterAdjustment: pofDiamAdj,
        ageAdjustment: pofAgeAdj,
        vintageOverride: pofVintageOverride,
        preRound: pofPreRound,
        level: pof,
      },
      cof: {
        diamScore: cofDiamScore,
        materialAdjustments: cofMaterialAdjustments,
        preRound: cofPreRound,
        level: cof,
      },
      risk: {
        product,
        riskBin,
        riskLabel,
      },
      formula: {
        pof: "PoF = if PCCP vintage override then that else clamp(round(baseMaterial + diameterAdjustment + ageAdjustment), 1, 4)",
        cof: "CoF = clamp(round(diameterScore with material caps/floors), 1, 4)",
        risk: "RiskClass = bin(PoF × CoF): <=4→1, <=8→2, <=12→3, else→4",
      },
      source: "doc",
    };
  }

  sanityCheck() {
    const cases = [
      {
        name: "CI old small (high PoF, moderate CoF)",
        input: { materialCode: "CI", diamMm: 150, installYear: 1960, lengthM: null },
        expect: { pof: 4, cof: 2, riskBin: 2 },
      },
      {
        name: "AC old small (high PoF, moderate CoF)",
        input: { materialCode: "AC", diamMm: 150, installYear: 1960, lengthM: null },
        expect: { pof: 4, cof: 2, riskBin: 2 },
      },
      {
        name: "DI typical small (moderate PoF, moderate CoF)",
        input: { materialCode: "DI", diamMm: 150, installYear: 1990, lengthM: null },
        expect: { pof: 3, cof: 2, riskBin: 2 },
      },
      {
        name: "PVC typical (low PoF, low CoF)",
        input: { materialCode: "PVC", diamMm: 150, installYear: 1990, lengthM: null },
        expect: { pof: 1, cof: 1, riskBin: 1 },
      },
      {
        name: "PCCP bad vintage (very high PoF + very high CoF)",
        input: { materialCode: "PCCP", diamMm: 600, installYear: 1976, lengthM: null },
        expect: { pof: 4, cof: 4, riskBin: 4 },
      },
      {
        name: "PCCP non-vintage (low PoF + very high CoF)",
        input: { materialCode: "PCCP", diamMm: 600, installYear: 1986, lengthM: null },
        expect: { pof: 1, cof: 4, riskBin: 2 },
      },
    ];

    const results = cases.map((c) => {
      const out = this.compute(c.input);
      const pass =
        out?.pof === c.expect.pof &&
        out?.cof === c.expect.cof &&
        out?.riskBin === c.expect.riskBin;
      return {
        name: c.name,
        input: c.input,
        expect: c.expect,
        got: { pof: out?.pof, cof: out?.cof, riskBin: out?.riskBin },
        pass,
      };
    });

    const failed = results.filter((r) => !r.pass);
    return {
      ok: failed.length === 0,
      failedCount: failed.length,
      results,
    };
  }
}
