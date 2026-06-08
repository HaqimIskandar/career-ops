#!/usr/bin/env node

/**
 * ats-validate.mjs — PDF-based ATS validation for career-ops
 *
 * Validates generated CV PDFs against real ATS parsing behavior.
 * Uses pdf-parse to extract text from the actual PDF (not HTML source).
 *
 * Usage:
 *   node ats-validate.mjs --pdf ~/CV/resume.pdf
 *   node ats-validate.mjs --dir ~/CV/
 *   node ats-validate.mjs --pdf ~/CV/resume.pdf --jd-keywords "contract,procurement,tender"
 *
 * Checks (7 layers):
 *   1. Text extraction  — PDF is parseable, not empty/garbled
 *   2. Section detection — Standard ATS headers present
 *   3. Contact extraction — Name, email, phone, LinkedIn parseable
 *   4. Date consistency  — All date ranges parseable
 *   5. Keyword coverage  — JD keywords present in extracted PDF text
 *   6. Encoding cleanliness — No problematic Unicode survived
 *   7. Single-column check — No multi-column layout artifacts
 */

import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, extname, basename } from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ATS_SECTIONS = [
  { pattern: /professional\s+summary/i, name: 'Professional Summary' },
  { pattern: /work\s+experience/i, name: 'Work Experience' },
  { pattern: /education/i, name: 'Education' },
  { pattern: /skills/i, name: 'Skills' },
  { pattern: /certifications?/i, name: 'Certifications' },
  { pattern: /core\s+competenc/i, name: 'Core Competencies' },
];

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_RE = /(\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?(\d{3,4}[-.\s]?\d{3,4}|X{3,})/;
const LINKEDIN_RE = /linkedin\.com\/in\//i;
const DATE_RE = /\b(19|20)\d{2}\s*[-–—]\s*((19|20)\d{2}|present)\b/gi;

// ATS-problematic Unicode (should have been normalized by generate-pdf)
const PROBLEMATIC_UNICODE = [
  { re: /\u2014/g, name: 'em-dash' },      // —
  { re: /\u2013/g, name: 'en-dash' },      // –
  { re: /\u2018|\u2019/g, name: 'smart-single-quote' },
  { re: /\u201C|\u201D/g, name: 'smart-double-quote' },
  { re: /\u200B/g, name: 'zero-width-space' },
  { re: /\u00A0/g, name: 'non-breaking-space' },
];

// ---------------------------------------------------------------------------
// Check implementations
// ---------------------------------------------------------------------------

function checkTextExtraction(text) {
  const issues = [];
  const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;

  if (!text || text.trim().length === 0) {
    return { pass: false, score: 0, detail: 'No text extracted — PDF may be image-based or corrupted', issues: ['empty-extraction'] };
  }
  if (wordCount < 50) {
    issues.push(`Low word count: ${wordCount}`);
  }

  return {
    pass: wordCount >= 50,
    score: wordCount >= 200 ? 100 : wordCount >= 100 ? 70 : wordCount >= 50 ? 40 : 0,
    detail: `${wordCount} words extracted`,
    issues,
  };
}

function checkSectionDetection(text) {
  const found = [];
  const missing = [];

  for (const section of ATS_SECTIONS) {
    if (section.pattern.test(text)) {
      found.push(section.name);
    } else {
      missing.push(section.name);
    }
  }

  // Require at least 4 sections (Summary, Experience, Education, Skills)
  const minRequired = 4;
  return {
    pass: found.length >= minRequired,
    score: Math.round((found.length / ATS_SECTIONS.length) * 100),
    detail: `Found: ${found.join(', ')}`,
    missing,
    found,
    issues: missing.length > ATS_SECTIONS.length - minRequired ? [`Missing: ${missing.join(', ')}`] : [],
  };
}

function checkContactExtraction(text) {
  const lines = text.split('\n').slice(0, 10).join('\n'); // Check first 10 lines
  const results = {
    email: EMAIL_RE.test(lines),
    phone: PHONE_RE.test(lines),
    linkedin: LINKEDIN_RE.test(lines),
    name: false,
  };

  // Name: first non-empty line that's not an email/phone/URL
  const firstLine = text.split('\n').find(l => l.trim().length > 0) || '';
  results.name = firstLine.trim().length > 0 && !EMAIL_RE.test(firstLine) && !firstLine.includes('http');

  const found = Object.values(results).filter(Boolean).length;
  const total = Object.keys(results).length;

  return {
    pass: found >= 3,
    score: Math.round((found / total) * 100),
    detail: `name=${results.name}, email=${results.email}, phone=${results.phone}, linkedin=${results.linkedin}`,
    found,
    issues: found < 3 ? [`Missing contact fields: ${Object.entries(results).filter(([,v]) => !v).map(([k]) => k).join(', ')}`] : [],
  };
}

function checkDateConsistency(text) {
  const dates = [...text.matchAll(DATE_RE)].map(m => m[0]);
  const presentCount = dates.filter(d => /present/i.test(d)).length;

  // Should have at least 2 date ranges for a meaningful career history
  const issues = [];
  if (dates.length < 2) issues.push(`Only ${dates.length} date range(s) found`);

  return {
    pass: dates.length >= 2,
    score: dates.length >= 4 ? 100 : dates.length >= 2 ? 70 : 30,
    detail: `${dates.length} date ranges found (${presentCount} present)`,
    dates: dates,
    issues,
  };
}

function checkKeywordCoverage(text, keywords) {
  if (!keywords || keywords.length === 0) {
    return { pass: true, score: 100, detail: 'No JD keywords provided — skipped', found: 0, total: 0, missing: [], issues: [] };
  }

  const lower = text.toLowerCase();
  const found = [];
  const missing = [];

  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) {
      found.push(kw);
    } else {
      missing.push(kw);
    }
  }

  const pct = Math.round((found.length / keywords.length) * 100);
  return {
    pass: pct >= 80,
    score: pct,
    detail: `${found.length}/${keywords.length} keywords (${pct}%)`,
    found: found.length,
    total: keywords.length,
    missing,
    issues: pct < 80 ? [`Missing: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '...' : ''}`] : [],
  };
}

function checkEncodingCleanliness(text) {
  const found = [];
  for (const { re, name } of PROBLEMATIC_UNICODE) {
    const matches = [...text.matchAll(re)];
    if (matches.length > 0) {
      found.push({ name, count: matches.length });
    }
  }

  return {
    pass: found.length === 0,
    score: found.length === 0 ? 100 : Math.max(0, 100 - found.length * 20),
    detail: found.length === 0 ? 'Clean — no problematic Unicode' : `Found: ${found.map(f => `${f.name}(${f.count}x)`).join(', ')}`,
    issues: found.length > 0 ? [found.map(f => `${f.name}(${f.count}x)`).join(', ')] : [],
  };
}

function checkSingleColumn(text) {
  // Multi-column PDFs produce text with interleaved line fragments.
  // Heuristic: check for many short lines (<30 chars) with sudden topic jumps
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  let shortLineRuns = 0;
  let maxRun = 0;
  let currentRun = 0;

  for (const line of lines) {
    if (line.trim().length < 30) {
      currentRun++;
    } else {
      if (currentRun > maxRun) maxRun = currentRun;
      if (currentRun >= 5) shortLineRuns++;
      currentRun = 0;
    }
  }
  if (currentRun > maxRun) maxRun = currentRun;
  if (currentRun >= 5) shortLineRuns++;

  // If many consecutive short lines, likely multi-column
  const isMultiColumn = maxRun > 15 || shortLineRuns > 3;

  return {
    pass: !isMultiColumn,
    score: isMultiColumn ? 30 : 100,
    detail: isMultiColumn ? `Possible multi-column: ${maxRun} consecutive short lines, ${shortLineRuns} runs` : 'Single-column layout confirmed',
    issues: isMultiColumn ? ['Multi-column layout may confuse ATS parsers'] : [],
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function validatePdf(pdfPath, options = {}) {
  const buffer = readFileSync(pdfPath);
  const uint8 = new Uint8Array(buffer);
  const parser = new PDFParse(uint8);
  const result = await parser.getText();
  const info = await parser.getInfo();
  parser.destroy();

  // pdf-parse v2 returns { pages: [{text:""}], text: string, total: N }
  const text = typeof result === 'string' ? result : (result.text || result.pages?.map(p => p.text).join('\n') || '');
  const numpages = info?.total || info?.numPages || info?.pages || (result.pages?.length) || 0;
  const pdfData = { text, numpages };

  const results = {
    file: basename(pdfPath),
    pages: pdfData.numpages,
    checks: {},
  };

  results.checks.textExtraction = checkTextExtraction(text);
  results.checks.sectionDetection = checkSectionDetection(text);
  results.checks.contactExtraction = checkContactExtraction(text);
  results.checks.dateConsistency = checkDateConsistency(text);
  results.checks.keywordCoverage = checkKeywordCoverage(text, options.keywords || []);
  results.checks.encodingCleanliness = checkEncodingCleanliness(text);
  results.checks.singleColumn = checkSingleColumn(text);

  // Overall score = weighted average
  const weights = {
    textExtraction: 20,
    sectionDetection: 20,
    contactExtraction: 15,
    dateConsistency: 10,
    keywordCoverage: 15,
    encodingCleanliness: 10,
    singleColumn: 10,
  };

  let totalWeight = 0;
  let weightedScore = 0;
  let allIssues = [];

  for (const [check, weight] of Object.entries(weights)) {
    if (results.checks[check]) {
      weightedScore += results.checks[check].score * weight;
      totalWeight += weight;
      if (results.checks[check].issues?.length > 0) {
        allIssues.push(...results.checks[check].issues);
      }
    }
  }

  results.overallScore = Math.round(weightedScore / totalWeight);
  results.pass = results.overallScore >= 80;
  results.issues = allIssues;

  return results;
}

function formatResult(r) {
  const icon = r.pass ? '✅' : r.overallScore >= 60 ? '⚠️' : '❌';
  const lines = [
    `\n${icon} ${r.file} — Score: ${r.overallScore}% (${r.pages} pages)`,
  ];

  for (const [name, check] of Object.entries(r.checks)) {
    const cIcon = check.pass ? '✓' : '✗';
    lines.push(`  ${cIcon} ${name}: ${check.score}% — ${check.detail}`);
  }

  if (r.issues.length > 0) {
    lines.push(`  ⚠ Issues: ${r.issues.join('; ')}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help')) {
  console.log(`
ats-validate.mjs — PDF-based ATS validation for career-ops

USAGE
  node ats-validate.mjs --pdf <path>           Validate single PDF
  node ats-validate.mjs --dir <path>            Validate all PDFs in directory
  node ats-validate.mjs --pdf <path> --json     Output as JSON
  node ats-validate.mjs --pdf <path> --jd-keywords "kw1,kw2,kw3"

OPTIONS
  --pdf <path>        Path to PDF file
  --dir <path>        Directory containing PDFs
  --jd-keywords <csv> Comma-separated JD keywords to check
  --json              Output results as JSON
  --save <path>       Save JSON results to file
  --help              Show this help

CHECKS
  1. Text extraction  — PDF parseable, sufficient word count
  2. Section detection — Standard ATS headers found
  3. Contact extraction — Name, email, phone, LinkedIn in header
  4. Date consistency  — Career date ranges parseable
  5. Keyword coverage  — JD keywords in extracted text (requires --jd-keywords)
  6. Encoding cleanliness — No problematic Unicode (em-dash, smart quotes)
  7. Single-column check — No multi-column layout artifacts

SCORING
  80%+ = PASS ✅ | 60-79% = MARGINAL ⚠️ | <60% = FAIL ❌
`);
  process.exit(0);
}

// Parse args
let pdfPath = null;
let dirPath = null;
let keywords = [];
let outputJson = false;
let savePath = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--pdf' && args[i + 1]) pdfPath = args[++i];
  else if (args[i] === '--dir' && args[i + 1]) dirPath = args[++i];
  else if (args[i] === '--jd-keywords' && args[i + 1]) keywords = args[++i].split(',').map(k => k.trim()).filter(Boolean);
  else if (args[i] === '--json') outputJson = true;
  else if (args[i] === '--save' && args[i + 1]) savePath = args[++i];
}

async function main() {
  const pdfFiles = [];

  if (pdfPath) {
    pdfFiles.push(pdfPath);
  } else if (dirPath) {
    const entries = readdirSync(dirPath);
    for (const entry of entries) {
      if (extname(entry).toLowerCase() === '.pdf') {
        pdfFiles.push(join(dirPath, entry));
      }
    }
  } else {
    console.error('Error: Provide --pdf <path> or --dir <path>');
    process.exit(1);
  }

  console.log(`\n📊 ATS Validation — ${pdfFiles.length} PDF(s)${keywords.length ? `, ${keywords.length} JD keywords` : ''}\n`);

  const allResults = [];
  let passCount = 0;
  let failCount = 0;

  for (const file of pdfFiles) {
    try {
      const result = await validatePdf(file, { keywords });
      allResults.push(result);

      if (!outputJson) console.log(formatResult(result));

      if (result.pass) passCount++;
      else failCount++;
    } catch (err) {
      console.error(`❌ ${basename(file)}: ${err.message}`);
      failCount++;
      allResults.push({ file: basename(file), error: err.message, overallScore: 0, pass: false });
    }
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📊 Summary: ${passCount} passed, ${failCount} failed out of ${pdfFiles.length}`);
  if (allResults.length > 0) {
    const avgScore = Math.round(allResults.reduce((s, r) => s + r.overallScore, 0) / allResults.length);
    console.log(`📈 Average score: ${avgScore}%`);
  }
  console.log(`${'='.repeat(60)}\n`);

  if (outputJson || savePath) {
    const json = JSON.stringify(allResults, null, 2);
    if (outputJson) console.log(json);
    if (savePath) {
      writeFileSync(savePath, json);
      console.log(`💾 Results saved to ${savePath}`);
    }
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main();
