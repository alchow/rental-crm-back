#!/usr/bin/env node
/* global console, process */

import { readFileSync, writeFileSync } from 'node:fs';

const [rawTypesPath, schemaPath, outputPath] = process.argv.slice(2);
if (!rawTypesPath || !schemaPath || !outputPath) {
  console.error('usage: normalize-database-types.mjs <raw-types> <schema-sql> <output>');
  process.exit(2);
}

const schema = readFileSync(schemaPath, 'utf8');
const generatedPhraseCount = schema.match(/\bGENERATED ALWAYS\b/g)?.length ?? 0;
const generatedColumns = [];
const tablePattern = /CREATE TABLE(?: IF NOT EXISTS)? "public"\."([^"]+)" \(\n([\s\S]*?)\n\);/g;

for (const tableMatch of schema.matchAll(tablePattern)) {
  const [, table, body] = tableMatch;
  for (const line of body.split('\n')) {
    if (!/\bGENERATED ALWAYS\b/.test(line)) continue;
    const column = /^\s*"([^"]+)"/.exec(line)?.[1];
    if (!column) {
      console.error(`FAIL: could not parse generated column in public.${table}: ${line}`);
      process.exit(1);
    }
    generatedColumns.push({ table, column });
  }
}

if (generatedColumns.length !== generatedPhraseCount) {
  console.error(
    `FAIL: found ${generatedPhraseCount} GENERATED ALWAYS clauses but parsed ` +
      `${generatedColumns.length} generated columns.`,
  );
  process.exit(1);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let types = readFileSync(rawTypesPath, 'utf8');
for (const { table, column } of generatedColumns) {
  const tableMarker = `      ${table}: {`;
  const tableStart = types.indexOf(tableMarker);
  if (tableStart < 0) {
    console.error(`FAIL: generated types are missing public.${table}.`);
    process.exit(1);
  }
  const tableTerminator = types.includes('\n      };\n      ', tableStart)
    ? '\n      };'
    : '\n      }';
  const nextTable = types.indexOf(`${tableTerminator}\n      `, tableStart);
  if (nextTable < 0) {
    console.error(`FAIL: could not isolate generated type block for public.${table}.`);
    process.exit(1);
  }

  let tableBlock = types.slice(tableStart, nextTable + tableTerminator.length);
  for (const section of ['Insert', 'Update']) {
    const sectionStart = tableBlock.indexOf(`        ${section}: {`);
    const sectionTerminator = tableBlock.includes('\n        };', sectionStart)
      ? '\n        };'
      : '\n        }';
    const sectionEnd = tableBlock.indexOf(sectionTerminator, sectionStart);
    if (sectionStart < 0 || sectionEnd < 0) {
      console.error(`FAIL: public.${table}.${section} type block was not found.`);
      process.exit(1);
    }
    const before = tableBlock.slice(0, sectionStart);
    let sectionBlock = tableBlock.slice(sectionStart, sectionEnd);
    const after = tableBlock.slice(sectionEnd);
    const property = new RegExp(`^          ${escapeRegExp(column)}\\??:.*;?$`, 'm');
    const matches = sectionBlock.match(property);
    if (!matches) {
      console.error(`FAIL: public.${table}.${section}.${column} type was not found.`);
      process.exit(1);
    }
    const semicolon = matches[0].endsWith(';') ? ';' : '';
    sectionBlock = sectionBlock.replace(property, `          ${column}?: never${semicolon}`);
    tableBlock = before + sectionBlock + after;
  }
  types = types.slice(0, tableStart) + tableBlock + types.slice(nextTable + tableTerminator.length);
}

writeFileSync(outputPath, types);
console.info(`Normalized ${generatedColumns.length} generated database column(s).`);
