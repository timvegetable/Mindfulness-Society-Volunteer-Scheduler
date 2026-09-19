#!/usr/bin/env node
// Parse the emitted Apps Script bundle and reject references to globals that
// are available in Node but not in Apps Script V8. This is deliberately an AST
// check rather than a text search: property names, strings, and comments may
// legitimately contain these words.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_BUNDLE = resolve(ROOT, 'dist/apps-script/Code.js');
const FORBIDDEN = new Set(['TextEncoder', 'TextDecoder', 'Buffer', 'process', 'structuredClone', 'crypto']);

function isGlobalThisProperty(node, name) {
  return ts.isPropertyAccessExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'globalThis'
    && ts.isIdentifier(node.name)
    && node.name.text === name;
}

function isTypeofGlobalThisProperty(node, name) {
  return ts.isTypeOfExpression(node)
    && isGlobalThisProperty(node.expression, name);
}

function isPropertyName(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return true;
  if (ts.isMethodSignature(parent) && parent.name === node) return true;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return true;
  if (ts.isPropertySignature(parent) && parent.name === node) return true;
  if (ts.isGetAccessorDeclaration(parent) && parent.name === node) return true;
  if (ts.isSetAccessorDeclaration(parent) && parent.name === node) return true;
  if (ts.isEnumMember(parent) && parent.name === node) return true;
  return false;
}

function isDeclarationName(node) {
  const parent = node.parent;
  if (!parent) return false;
  return (ts.isVariableDeclaration(parent) && parent.name === node)
    || (ts.isParameter(parent) && parent.name === node)
    || (ts.isBindingElement(parent) && parent.name === node)
    || (ts.isFunctionDeclaration(parent) && parent.name === node)
    || (ts.isClassDeclaration(parent) && parent.name === node)
    || (ts.isImportClause(parent) && parent.name === node)
    || (ts.isImportSpecifier(parent) && parent.name === node)
    || (ts.isTypeAliasDeclaration(parent) && parent.name === node)
    || (ts.isInterfaceDeclaration(parent) && parent.name === node);
}

function isEncoderGuard(expression) {
  return isTypeofGuard(expression, 'TextEncoder', ['function']);
}

function isCryptoGuard(expression) {
  return isTypeofGuard(expression, 'crypto', ['object']);
}

function isTypeofGuard(expression, name, availableTypes) {
  if (!ts.isBinaryExpression(expression)) return false;
  const operator = expression.operatorToken.kind;
  const equals = operator === ts.SyntaxKind.EqualsEqualsEqualsToken
    || operator === ts.SyntaxKind.EqualsEqualsToken
  const notEquals = operator === ts.SyntaxKind.ExclamationEqualsEqualsToken
    || operator === ts.SyntaxKind.ExclamationEqualsToken;
  if (!equals && !notEquals) return false;
  const leftTypeof = isTypeofGlobalThisProperty(expression.left, name);
  const rightTypeof = isTypeofGlobalThisProperty(expression.right, name);
  const literal = leftTypeof ? expression.right : rightTypeof ? expression.left : undefined;
  if (!(leftTypeof || rightTypeof) || !ts.isStringLiteral(literal)) return false;
  return equals ? availableTypes.includes(literal.text) : literal.text === 'undefined';
}

function addBindingName(bindings, node) {
  if (ts.isIdentifier(node)) {
    bindings.add(node.text);
    return;
  }
  if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
    for (const element of node.elements) {
      if (ts.isBindingElement(element)) addBindingName(bindings, element.name);
    }
  }
}

function directBindings(node, inherited) {
  const bindings = new Set(inherited);
  if (!ts.isSourceFile(node) && !ts.isBlock(node)) return bindings;
  for (const statement of node.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) addBindingName(bindings, declaration.name);
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      bindings.add(statement.name.text);
    }
  }
  return bindings;
}

function lineAndColumn(sourceFile, node) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${line + 1}:${character + 1}`;
}

/** Return all forbidden global references found in an emitted bundle. */
export function auditServerBundle(source, fileName = '<bundle>') {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const issues = [];

  function visit(node, encoderGuarded = false, cryptoGuarded = false, bindings = new Set()) {
    if (ts.isIfStatement(node)) {
      visit(node.expression, encoderGuarded, cryptoGuarded, bindings);
      visit(node.thenStatement, encoderGuarded || isEncoderGuard(node.expression), cryptoGuarded || isCryptoGuard(node.expression), bindings);
      if (node.elseStatement) visit(node.elseStatement, encoderGuarded, cryptoGuarded, bindings);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      visit(node.condition, encoderGuarded, cryptoGuarded, bindings);
      visit(node.whenTrue, encoderGuarded || isEncoderGuard(node.condition), cryptoGuarded || isCryptoGuard(node.condition), bindings);
      visit(node.whenFalse, encoderGuarded, cryptoGuarded, bindings);
      return;
    }
    if (ts.isFunctionLike(node)) {
      const functionBindings = new Set(bindings);
      for (const parameter of node.parameters) addBindingName(functionBindings, parameter.name);
      if (node.name && ts.isIdentifier(node.name)) functionBindings.add(node.name.text);
      if (node.body) visit(node.body, encoderGuarded, cryptoGuarded, functionBindings);
      return;
    }
    const scopedBindings = ts.isSourceFile(node) || ts.isBlock(node) ? directBindings(node, bindings) : bindings;
    if (ts.isIdentifier(node)) {
      const name = node.text;
      const globalThisProperty = isGlobalThisProperty(node.parent, name);
      const allowedGlobalThisProperty = name === 'crypto' && globalThisProperty
        && (cryptoGuarded || isTypeofGlobalThisProperty(node.parent.parent, name));
      const allowedEncoderProperty = name === 'TextEncoder' && globalThisProperty
          && (encoderGuarded || isTypeofGlobalThisProperty(node.parent.parent, name));
      const propertyName = isPropertyName(node) && !globalThisProperty;
      if (FORBIDDEN.has(name) && !propertyName && !scopedBindings.has(name) && !isDeclarationName(node)) {
        if (!allowedGlobalThisProperty && !allowedEncoderProperty) {
          issues.push({ name, location: lineAndColumn(sourceFile, node) });
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, encoderGuarded, cryptoGuarded, scopedBindings));
  }

  visit(sourceFile);
  return issues;
}

async function main() {
  const fileName = resolve(process.argv[2] ?? DEFAULT_BUNDLE);
  const source = await readFile(fileName, 'utf8');
  const issues = auditServerBundle(source, fileName);
  if (issues.length > 0) {
    for (const issue of issues) console.error(`${fileName}:${issue.location} references unsupported global ${issue.name}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Apps Script bundle audit passed: ${fileName}`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main();
