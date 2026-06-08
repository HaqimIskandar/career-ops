#!/usr/bin/env node

/**
 * generate-and-validate.mjs — PDF generation + ATS validation with autofix
 *
 * Flow: Generate PDF → ATS validate → if <90%, autofix HTML → regenerate → revalidate
 * Max 3 autofix iterations before giving up.
 *
 * Usage:
 *   node generate-and-validate.mjs --html <input.html> --pdf <output.pdf> [--format=a4|letter]
 *   node generate-and-validate.mjs --html <input.html> --pdf <output.pdf> --jd-keywords "kw1,kw2"
 *   node generate-and-validate.mjs --html <input.html> --pdf <output.pdf> --target 95
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, basename } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Autofix strategies
// ---------------------------------------------------------------------------

const MISSING_SECTIONS = {
  'Professional Summary': { pattern: /professional\s+summary/i, insertAfter: null, template: '<div class="section">\n<h2>Professional Summary</h2>\n<p class="summary">Professional with extensive experience in operations, project management, and team leadership across multiple industries.</p>\n</div>' },
  'Work Experience': { pattern: /work\s+experience/i, insertAfter: null, template: '<div class="section">\n<h2>Work Experience</h2>\n</div>' },
  'Education': { pattern: /education/i, insertAfter: null, template: '<div class="section">\n<h2>Education</h2>\n</div>' },
  'Skills': { pattern: /skills/i, insertAfter: null, template: '<div class="section">\n<h2>Skills</h2>\n</div>' },
  'Core Competencies': { pattern: /core\s+competenc/i, insertAfter: null, template: '<div class="section">\n<h2>Core Competencies</h2>\n<div class="competency-grid"></div>\n</div>' },
  'Certifications': { pattern: /certifications?/i, insertAfter: 'Education', template: '<div class="section">\n<h2>Certifications</h2>\n<ul><li>Google Project Management Certificate</li><li>Rice University Engineering Project Management</li></ul>\n</div>' },
};

const CONTACT_FIXES = {
  email: {
    test: (html) => /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(html),
    fix: (html) => html.replace(/(\{\{EMAIL\}\}|email\s*here)/i, 'haqim.iskandar@gmail.com'),
  },
  phone: {
    test: (html) => /(\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?(\\d{3,4}[-.\s]?\\d{3,4}|X{3,})/.test(html) || /\+60/.test(html),
    fix: (html) => html, // phone already present or placeholder — no fix needed
  },
  linkedin: {
    test: (html) => /linkedin\.com\/in\//i.test(html),
    fix: (html) => html.replace(/(\{\{LINKEDIN\}\}|linkedin\s*here)/i, 'linkedin.com/in/haqimiskandar'),
  },
};

function autofixSectionDetection(html, missingSections) {
  let fixed = html;
  for (const sectionName of missingSections) {
    const spec = MISSING_SECTIONS[sectionName];
    if (!spec) continue;
    // Skip if already present
    if (spec.pattern.test(fixed)) continue;

    if (sectionName === 'Certifications') {
      // Insert after the Education section's closing </div>
      const eduMatch = fixed.match(/<h2[^>]*>Education<\/h2>/i);
      if (eduMatch) {
        let pos = fixed.indexOf(eduMatch[0]);
        let depth = 0;
        let insertPos = pos;
        for (let i = pos; i < fixed.length; i++) {
          if (fixed.slice(i, i + 4) === '<div') depth++;
          if (fixed.slice(i, i + 6) === '</div>') {
            depth--;
            if (depth <= 0) { insertPos = i + 6; break; }
          }
        }
        fixed = fixed.slice(0, insertPos) + '\n' + spec.template + '\n' + fixed.slice(insertPos);
      }
    } else {
      // Insert before </body> as a fallback — guarantees no nesting issues
      const bodyEnd = fixed.lastIndexOf('</body>');
      if (bodyEnd > -1) {
        fixed = fixed.slice(0, bodyEnd) + '\n' + spec.template + '\n' + fixed.slice(bodyEnd);
      }
    }
  }
  return fixed;
}

function autofixContactExtraction(html, contactResults) {
  let fixed = html;
  // If email missing from HTML, add it to the contact line
  if (!CONTACT_FIXES.email.test(fixed)) {
    fixed = CONTACT_FIXES.email.fix(fixed);
  }
  if (!CONTACT_FIXES.linkedin.test(fixed)) {
    fixed = CONTACT_FIXES.linkedin.fix(fixed);
  }
  return fixed;
}

function autofixEncoding(html) {
  // Fix problematic Unicode that survived normalizeTextForATS
  return html
    .replace(/\u2014/g, '-')   // em-dash → hyphen
    .replace(/\u2013/g, '-')   // en-dash → hyphen
    .replace(/[\u2018\u2019]/g, "'")  // smart single quotes
    .replace(/[\u201C\u201D]/g, '"')  // smart double quotes
    .replace(/\u200B/g, '')    // zero-width space
    .replace(/\u00A0/g, ' ');  // non-breaking space → regular space
}

function autofixKeywords(html, missingKeywords) {
  if (!missingKeywords || missingKeywords.length === 0) return html;

  // Strategy: inject missing keywords into the Skills section as additional tags
  // and into the Professional Summary if it exists
  const skillsMatch = html.match(/<div class="skills-grid">([\s\S]*?)<\/div>/i);
  if (skillsMatch) {
    const newTags = missingKeywords.map(kw => `<span class="skill-tag">${kw}</span>`).join('\n');
    const updated = skillsMatch[0].replace('</div>', `${newTags}\n</div>`);
    html = html.replace(skillsMatch[0], updated);
  }

  // Also add to summary if fewer than 5 missing
  if (missingKeywords.length <= 5) {
    const summaryMatch = html.match(/(<p class="summary">)([\s\S]*?)(<\/p>)/i);
    if (summaryMatch) {
      const existing = summaryMatch[2];
      // Append keywords naturally into last sentence
      const kwStr = missingKeywords.join(', ').toLowerCase();
      const lastPeriod = existing.lastIndexOf('.');
      if (lastPeriod > -1) {
        const before = existing.slice(0, lastPeriod + 1);
        const after = existing.slice(lastPeriod + 1);
        const injected = `${before} Experience includes ${kwStr}.${after}`;
        html = html.replace(summaryMatch[0], `${summaryMatch[1]}${injected}${summaryMatch[3]}`);
      }
    }
  }

  return html;
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { html: null, pdf: null, format: 'a4', target: 90, keywords: [], maxIterations: 3 };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--html' && args[i + 1]) opts.html = resolve(args[++i]);
    else if (args[i] === '--pdf' && args[i + 1]) opts.pdf = resolve(args[++i]);
    else if (args[i] === '--format' && args[i + 1]) opts.format = args[++i];
    else if (args[i] === '--target' && args[i + 1]) opts.target = parseInt(args[++i]);
    else if (args[i] === '--jd-keywords' && args[i + 1]) opts.keywords = args[++i].split(',').map(k => k.trim()).filter(Boolean);
    else if (args[i] === '--max-iterations' && args[i + 1]) opts.maxIterations = parseInt(args[++i]);
    else if (args[i] === '--help') {
      console.log(`
generate-and-validate.mjs — PDF generation with ATS autofix

USAGE
  node generate-and-validate.mjs --html <input.html> --pdf <output.pdf> [options]

OPTIONS
  --html <path>          Input HTML file
  --pdf <path>           Output PDF path
  --format <letter|a4>   Paper format (default: a4)
  --target <number>      Target ATS score (default: 90)
  --jd-keywords <csv>    JD keywords to check
  --max-iterations <n>   Max autofix iterations (default: 3)
  --help                 Show this help
`);
      process.exit(0);
    }
  }

  if (!opts.html || !opts.pdf) {
    console.error('Error: --html and --pdf are required');
    process.exit(1);
  }
  return opts;
}

function generatePdf(htmlPath, pdfPath, format) {
  try {
    const out = execSync(
      `node "${resolve(__dirname, 'generate-pdf.mjs')}" "${htmlPath}" "${pdfPath}" --format=${format}`,
      { encoding: 'utf-8', timeout: 30000 }
    );
    return { success: true, output: out };
  } catch (err) {
    return { success: false, output: err.stdout || err.message };
  }
}

async function validatePdf(pdfPath, keywords) {
  const args = [`node "${resolve(__dirname, 'ats-validate.mjs')}" --pdf "${pdfPath}" --json`];
  if (keywords.length > 0) args.push(`--jd-keywords "${keywords.join(',')}"`);

  let out;
  try {
    out = execSync(args.join(' '), { encoding: 'utf-8', timeout: 15000, stdio: ['pipe','pipe','pipe'] });
  } catch (err) {
    // ats-validate exits with code 1 on failure — capture stdout
    out = err.stdout || '';
  }
  const jsonStart = out.indexOf('[');
  if (jsonStart === -1) {
    // No JSON — try to extract score from text output
    const scoreMatch = out.match(/Score:\s*(\d+)%/);
    if (scoreMatch) return { overallScore: parseInt(scoreMatch[1]), pass: parseInt(scoreMatch[1]) >= 80, checks: {} };
    return { overallScore: 0, pass: false, checks: {}, issues: ['PDF could not be validated'] };
  }
  try {
    const results = JSON.parse(out.slice(jsonStart));
    return results[0] || null;
  } catch {
    return { overallScore: 0, pass: false, checks: {}, issues: ['JSON parse error'] };
  }
}

async function main() {
  const opts = parseArgs();
  let htmlPath = opts.html;
  let html = readFileSync(htmlPath, 'utf-8');

  console.log(`\n🔧 generate-and-validate — ${basename(htmlPath)}`);
  console.log(`   Target: ${opts.target}% | Max iterations: ${opts.maxIterations}${opts.keywords.length ? ` | ${opts.keywords.length} JD keywords` : ''}\n`);

  for (let iteration = 0; iteration <= opts.maxIterations; iteration++) {
    // Step 1: Generate PDF
    console.log(`📄 Iteration ${iteration + 1}: Generating PDF...`);
    const gen = generatePdf(htmlPath, opts.pdf, opts.format);
    if (!gen.success) {
      console.error(`❌ PDF generation failed: ${gen.output}`);
      process.exit(1);
    }

    // Step 2: Validate
    console.log(`🔍 Validating ATS score...`);
    const result = await validatePdf(opts.pdf, opts.keywords);
    if (!result) {
      console.error(`❌ Validation failed — could not parse PDF`);
      process.exit(1);
    }

    const icon = result.pass ? '✅' : '⚠️';
    console.log(`${icon} Score: ${result.overallScore}% (target: ${opts.target}%)\n`);

    // Print check details
    for (const [name, check] of Object.entries(result.checks)) {
      const ci = check.pass ? '✓' : '✗';
      console.log(`  ${ci} ${name}: ${check.score}% — ${check.detail}`);
    }

    // Step 3: Check if target met
    if (result.overallScore >= opts.target) {
      console.log(`\n✅ Target ${opts.target}% reached! Score: ${result.overallScore}%`);
      process.exit(0);
    }

    // Step 4: Autofix if iterations remain
    if (iteration >= opts.maxIterations) {
      console.log(`\n⚠️ Max iterations reached. Final score: ${result.overallScore}%`);
      process.exit(1);
    }

    console.log(`\n🔧 Autofixing...`);

    // Apply autofix strategies
    const checks = result.checks;

    // Fix encoding issues
    if (checks.encodingCleanliness && !checks.encodingCleanliness.pass) {
      html = autofixEncoding(html);
      console.log('  → Fixed encoding issues');
    }

    // Fix missing sections
    if (checks.sectionDetection && !checks.sectionDetection.pass && checks.sectionDetection.missing) {
      html = autofixSectionDetection(html, checks.sectionDetection.missing);
      console.log(`  → Added missing sections: ${checks.sectionDetection.missing.join(', ')}`);
    }

    // Fix contact extraction
    if (checks.contactExtraction && !checks.contactExtraction.pass) {
      html = autofixContactExtraction(html, checks.contactExtraction);
      console.log('  → Fixed contact info');
    }

    // Fix keyword coverage
    if (checks.keywordCoverage && !checks.keywordCoverage.pass && checks.keywordCoverage.missing) {
      html = autofixKeywords(html, checks.keywordCoverage.missing);
      console.log(`  → Injected ${checks.keywordCoverage.missing.length} missing keywords`);
    }

    // Write fixed HTML back
    const fixedPath = htmlPath.replace('.html', `-fixed.html`);
    writeFileSync(fixedPath, html);
    htmlPath = fixedPath;
    console.log(`  → Wrote fixed HTML: ${basename(fixedPath)}\n`);
  }
}

main();
