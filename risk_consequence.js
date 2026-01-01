export class RiskConsequenceModel {
  constructor({ currentYear = new Date().getFullYear() } = {}) {
    this.currentYear = currentYear;
    this.riskLabels = ["Low", "Medium", "High", "Very High"];
    this._comboOverrides = null;
  }

  clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  riskPalette() {
    const base =
      d3.schemeRdYlGn?.[5] ?? ["#d73027", "#fc8d59", "#fee08b", "#d9ef8b", "#1a9850"];
    return [base[4], base[3], base[1], base[0]];
  }

  consequencePalette() {
    const base =
      d3.schemeBlues?.[5] ?? ["#eff6ff", "#bfdbfe", "#60a5fa", "#2563eb", "#1e3a8a"];
    return [base[1], base[2], base[3], base[4]];
  }

  normalizeMaterial(raw) {
    const s = (raw ?? "").toString().trim().toUpperCase();
    return s || "Unknown";
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

  pofScoreFrom({ materialCode, installYear, statusInd } = {}) {
    // PoF proxy based on the qualitative guidance in
    // docs/Pipe_Risk_Assessment_Water_Mains_North_America.docx.
    const mat = this.normalizeMaterial(materialCode);
    const iy = installYear ?? null;
    const age = this.ageYears(iy);
    const status = (statusInd ?? "").toString().trim().toUpperCase();

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
      ["PCI", 1],
      ["PCCP", 1],
      ["CU", 2],
      ["COPPER", 2],
    ]);

    let score = baseByMaterial.get(mat) ?? 2;

    // Age/vintage adjustments from the doc text.
    if (typeof age === "number" && Number.isFinite(age)) {
      if (mat === "CI" && age >= 50) score += 1;
      if (mat === "AC" && age >= 50) score += 1;

      // DI generally performs well; bump only at older ages.
      if ((mat === "DI" || mat === "PDI" || mat === "YDI") && age >= 75) score += 1;

      // Copper is chemistry dependent; lightly increase at older ages.
      if (mat === "CU" && age >= 70) score += 1;
    }

    // PCCP vintage-specific risk: 1970–1980 elevated, 1975–1978 highest.
    if (iy != null && (mat === "PCI" || mat === "PCCP")) {
      if (iy >= 1970 && iy <= 1980) score += 1;
      if (iy >= 1975 && iy <= 1978) score += 1;
    }

    // Status adjustment: if status indicates out-of-service/abandoned/etc.
    if (status.includes("ABAND") || status.includes("OUT") || status.includes("INACT")) {
      score += 1;
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

  setCombinationOverrides(map) {
    // Map key: `${MATERIAL}|${DIAM}|${YEAR}` (material uppercased; diam/year trimmed).
    // Value: { LoF:number|null, CoF:number|null, RiskClass?:string, family?:string }
    this._comboOverrides = map ?? null;
  }

  _makeComboKey(materialRaw, diamRaw, yearRaw) {
    const m = (materialRaw ?? "").toString().trim().toUpperCase();
    const d = (diamRaw ?? "").toString().trim();
    const y = (yearRaw ?? "").toString().trim();
    return `${m}|${d}|${y}`;
  }

  scoreFromFloat01to4(x) {
    // CSV has LoF/CoF like 1.5, 2.5, 4.5, 5.0. Collapse to 1..4.
    if (typeof x !== "number" || !Number.isFinite(x)) return null;
    if (x <= 2.0) return 1;
    if (x <= 3.0) return 2;
    if (x <= 4.0) return 3;
    return 4;
  }

  compute({ materialCode, diamMm, installYear, statusInd, lengthM, comboKeyParts } = {}) {
    // If provided, prefer CSV overrides keyed by raw (material, diam, year) combination.
    // comboKeyParts: { materialRaw, diamRaw, yearRaw }
    if (this._comboOverrides && comboKeyParts) {
      const key = this._makeComboKey(
        comboKeyParts.materialRaw,
        comboKeyParts.diamRaw,
        comboKeyParts.yearRaw
      );
      const o = this._comboOverrides.get(key);
      if (o) {
        const pof = this.scoreFromFloat01to4(o.LoF);
        const cof = this.scoreFromFloat01to4(o.CoF);
        const pofFinal = pof ?? this.pofScoreFrom({ materialCode, installYear, statusInd });
        const cofFinal = cof ?? this.consequenceScoreFrom({ materialCode, diamMm, lengthM });
        const riskBin = this.riskBinFromScores(pofFinal, cofFinal);
        return {
          pof: pofFinal,
          cof: cofFinal,
          pofFloat: typeof o.LoF === "number" && Number.isFinite(o.LoF) ? o.LoF : pofFinal,
          cofFloat: typeof o.CoF === "number" && Number.isFinite(o.CoF) ? o.CoF : cofFinal,
          riskBin,
          riskClass: (o.RiskClass ?? "").toString().trim() || null,
          family: (o.family ?? "").toString().trim() || null,
          source: "csv",
        };
      }
    }

    const pof = this.pofScoreFrom({ materialCode, installYear, statusInd });
    const cof = this.consequenceScoreFrom({ materialCode, diamMm, lengthM });
    const riskBin = this.riskBinFromScores(pof, cof);
    return {
      pof,
      cof,
      pofFloat: pof,
      cofFloat: cof,
      riskBin,
      riskClass: null,
      family: null,
      source: "doc",
    };
  }
}
