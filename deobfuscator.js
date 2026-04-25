'use strict';

const fs   = require('fs');
const path = require('path');

const VERSION = '2.0.0';

const IL_POOL_ENTRIES = [
  'IIIIIIII1','vvvvvv1','vvvvvvvv2','vvvvvv3','IIlIlIlI1','lvlvlvlv2',
  'I1','l1','v1','v2','v3','II','ll','vv','I2'
];

const HANDLER_POOL_PREFIXES = [
  'KQ','HF','W8','SX','Rj','nT','pL','qZ','mV','xB','yC','wD'
];

const MAX_UNWRAP_DEPTH = 60;

const MAX_MATH_PASSES = 100;

const ROBLOX_SERVICES = [
  'ScreenGui','Frame','TextLabel','TextButton','Humanoid',
  'Player','Players','RunService','TweenService','workspace',
  'game','script','Instance'
];

function isArithmeticSafe(s) {
  return /^[\d\s\+\-\*\/\%\(\)\.eE]+$/.test(s.trim());
}

function safeEvalMath(expr) {
  if (!expr && expr !== 0) return null;
  const s = String(expr).trim();
  if (!s) return null;

  if (/^\d+$/.test(s)) return parseInt(s, 10);

  if (!isArithmeticSafe(s)) return null;

  try {

    const result = new Function('"use strict"; return (' + s + ');')();
    if (typeof result === 'number' && isFinite(result)) {
      return Math.round(result);
    }
    return null;
  } catch {
    return null;
  }
}

function simplifyMathExpressions(code) {
  let result = code;
  let changed = true;
  let passes = 0;

  while (changed && passes < MAX_MATH_PASSES) {
    changed = false;
    passes++;

    const next = result.replace(/\(([^()]+)\)/g, (match, inner) => {
      if (!isArithmeticSafe(inner)) return match;
      const val = safeEvalMath(inner);
      if (val === null) return match;
      changed = true;
      return String(val);
    });
    if (next !== result) result = next;


    const trivial = result
      .replace(/\b(\d+)\s*\+\s*0\b/g,  (_, n) => { changed = true; return n; })
      .replace(/\b0\s*\+\s*(\d+)\b/g,  (_, n) => { changed = true; return n; })
      .replace(/\b(\d+)\s*\*\s*1\b/g,  (_, n) => { changed = true; return n; })
      .replace(/\b1\s*\*\s*(\d+)\b/g,  (_, n) => { changed = true; return n; })
      .replace(/\b(\d+)\s*\/\s*1\b/g,  (_, n) => { changed = true; return n; })
      .replace(/\b(\d+)\s*-\s*0\b/g,   (_, n) => { changed = true; return n; });
    if (trivial !== result) result = trivial;

    result = result.replace(/\b(\d+)\s*([\+\-\*\/])\s*(\d+)\b(?!\s*[\*\/])/g, (m, a, op, b) => {
      const av = parseInt(a, 10), bv = parseInt(b, 10);
      let v;
      switch (op) {
        case '+': v = av + bv; break;
        case '-': v = av - bv; break;
        case '*': v = av * bv; break;
        case '/': if (bv === 0) return m; v = Math.floor(av / bv); break;
        default: return m;
      }
      if (!isFinite(v)) return m;
      changed = true;
      return String(v);
    });
  }

  return result;
}

function simplifyMBAPatterns(code) {

  return code.replace(
    /\(\(\s*(\d+)\s*\*\s*(\d+)\s*-\s*(\d+)\s*\)\s*\/\s*\(\s*(\d+)\s*\+\s*1\s*\)\s*\+\s*(\d+)\s*\)/g,
    (match, n1, a, a2, b, n2) => {
      if (n1 !== n2) return match;
      const n = parseInt(n1, 10), aVal = parseInt(a, 10), a2Val = parseInt(a2, 10);
      if (aVal !== a2Val) return match;
      const bVal = parseInt(b, 10);
      const result = ((n * aVal - aVal) / (bVal + 1)) + n;
      if (Number.isInteger(result)) return String(result);
      return match;
    }
  );
}

function splitTopLevelCommas(s) {
  const parts = [];
  let depth = 0, buf = '';
  for (const ch of s) {
    if      (ch === '(') { depth++; buf += ch; }
    else if (ch === ')') { depth--; buf += ch; }
    else if (ch === ',' && depth === 0) { parts.push(buf); buf = ''; }
    else buf += ch;
  }
  if (buf) parts.push(buf);
  return parts;
}

function decodeStringChar(code) {

  let result = simplifyMathExpressions(code);

  return result.replace(/string\.char\s*\(([^)]+)\)/g, (match, inner) => {

    const simplified = simplifyMathExpressions(inner);
    const parts = splitTopLevelCommas(simplified);
    const chars = [];
    for (const part of parts) {
      const n = safeEvalMath(part.trim());
      if (n === null || n < 0 || n > 255) return match;
      chars.push(String.fromCharCode(n));
    }
    const decoded = chars.join('');

    const escaped = decoded
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r');
    return `"${escaped}"`;
  });
}

const RUNTIME_ID_MAP = {
  'assert':     'assert',
  'loadstring': 'loadstring',
  'game':       'game',
  'HttpGet':    'HttpGet',
  'print':      'print',
  'tostring':   'tostring',
  'tonumber':   'tonumber',
  'pcall':      'pcall',
  'error':      'error',
  'type':       'type',
  'rawget':     'rawget',
  'rawset':     'rawset',
  'setfenv':    'setfenv',
  'getfenv':    'getfenv',
  'unpack':     'unpack',
  'select':     'select',
  'next':       'next',
  'pairs':      'pairs',
  'ipairs':     'ipairs',
  'require':    'require',
};

function resolveGetfenvStrings(code) {
  let result = code;

  result = result.replace(/getfenv\s*\(\s*\)\s*\[\s*"([^"]+)"\s*\]/g, (m, key) => {
    return RUNTIME_ID_MAP[key] || key;
  });

  result = result.replace(/getfenv\s*\(\s*\)\s*\[\s*'([^']+)'\s*\]/g, (m, key) => {
    return RUNTIME_ID_MAP[key] || key;
  });

  result = result.replace(/_G\s*\[\s*"([^"]+)"\s*\]/g, (m, key) => {
    return RUNTIME_ID_MAP[key] || m;
  });

  result = result.replace(
    /(\w+)\s*\[\s*"HttpGet"\s*\]\s*\(\s*\1\s*,\s*([^)]+)\)/g,
    (m, gameVar, urlExpr) => `game:HttpGet(${urlExpr})`
  );

  return result;
}

function extractNumericArray(str) {
  if (!str || !str.trim()) return [];
  const parts = splitTopLevelCommas(str.trim());
  return parts.map(p => {
    const s = simplifyMathExpressions(p.trim());
    const v = safeEvalMath(s);
    if (v !== null) return v;
    const n = parseFloat(s);
    return isNaN(n) ? null : Math.floor(n);
  });
}

function decryptVMPayload(code) {





  const headerRx = /local\s+(\w+)\s*=\s*\{\}\s+local\s+(\w+)\s*=\s*(\d+)\s+local\s+(\w+)\s*=\s*(\d+)\b/;
  const hMatch = code.match(headerRx);
  if (!hMatch) {
    return { success: false, error: 'Cannot locate STACK/KEY/SALT triple' };
  }

  const STACK_VAR = hMatch[1];
  const KEY_VAR   = hMatch[2];
  const seed      = parseInt(hMatch[3], 10);
  const SALT_VAR  = hMatch[4];
  const saltVal   = parseInt(hMatch[5], 10);

  if (isNaN(seed) || isNaN(saltVal)) {
    return { success: false, error: `Non-numeric seed(${hMatch[3]}) or salt(${hMatch[5]})` };
  }





  const poolDecls = new Map();
  const pdRx = /local\s+(\w+)\s*=\s*\{([\d,\s]+)\}/g;
  let pdMatch;
  while ((pdMatch = pdRx.exec(code)) !== null) {
    const name = pdMatch[1];

    if (name === STACK_VAR) continue;
    const nums = pdMatch[2]
      .split(',')
      .map(n => parseInt(n.trim(), 10))
      .filter(n => !isNaN(n));
    if (nums.length > 0) poolDecls.set(name, nums);
  }

  if (poolDecls.size === 0) {
    return { success: false, error: 'No pool variable declarations found' };
  }

  const poolArrRx = /local\s+_pool\s*=\s*\{(\w+(?:\s*,\s*\w+)*)\}/;
  const paMatch = code.match(poolArrRx);
  if (!paMatch) {



    const allNames = [...poolDecls.keys()];
    if (allNames.length === 0) return { success: false, error: 'Cannot locate _pool array' };


    return decryptWithExplicitPool(code, poolDecls, seed, saltVal, allNames);
  }

  const poolOrder = paMatch[1].split(',').map(s => s.trim());

  const orderRx = /local\s+_order\s*=\s*\{([\d,\s]+)\}/;
  const oMatch = code.match(orderRx);
  if (!oMatch) {
    return { success: false, error: 'Cannot locate _order array' };
  }

  const realIndices = oMatch[1]
    .split(',')
    .map(n => parseInt(n.trim(), 10))
    .filter(n => !isNaN(n));

  if (realIndices.length === 0) {
    return { success: false, error: '_order array is empty or unparseable' };
  }

  return _runDecryption(poolOrder, poolDecls, realIndices, seed, saltVal);
}

function decryptWithExplicitPool(code, poolDecls, seed, saltVal, allNames) {
  const orderRx = /local\s+_order\s*=\s*\{([\d,\s]+)\}/;
  const oMatch  = code.match(orderRx);
  if (!oMatch) return { success: false, error: 'No _order found in fallback path' };

  const realIndices = oMatch[1]
    .split(',').map(n => parseInt(n.trim(), 10)).filter(n => !isNaN(n));

  return _runDecryption(allNames, poolDecls, realIndices, seed, saltVal);
}

function _runDecryption(poolOrder, poolDecls, realIndices, seed, saltVal) {
  const outputChars = [];
  let globalIdx = 0;
  const errors  = [];

  for (const luaIdx of realIndices) {

    const varName = poolOrder[luaIdx - 1];
    if (!varName) {
      errors.push(`_order references pool index ${luaIdx} but pool only has ${poolOrder.length} entries`);
      continue;
    }
    const encBytes = poolDecls.get(varName);
    if (!encBytes) {
      errors.push(`Pool variable "${varName}" has no declaration`);
      continue;
    }

    for (const encByte of encBytes) {

      let dec = ((encByte - seed - (globalIdx * saltVal)) % 256 + 256) % 256;
      outputChars.push(String.fromCharCode(dec));
      globalIdx++;
    }
  }

  const payload = outputChars.join('');

  if (payload.length === 0) {
    return {
      success: false,
      error: `Decryption produced empty output. Errors: ${errors.join('; ')}`
    };
  }

  return {
    success: true,
    payload,
    metadata: {
      seed,
      saltVal,
      realChunkCount:  realIndices.length,
      totalPoolSize:   poolOrder.length,
      payloadLength:   payload.length,
      warnings:        errors,
    }
  };
}

const ANTI_DEBUG_PATTERNS = [

  /local\s+\w+\s*=\s*os\.clock\s*\(\s*\)\s+(?:local\s+\w+\s*=\s*\w+\s*\(\s*\)\s+)?for\s+_\s*=\s*1\s*,\s*150000\s+do\s+end\s+if\s+os\.clock\s*\(\s*\)\s*-\s*\w+\s*>\s*5\.0\s+then\s+while\s+true\s+do\s+end\s+end\s*/g,

  /local\s+\w+\s*=\s*os\.clock\s+local\s+\w+\s*=\s*\w+\s*\(\s*\)\s+for\s+_\s*=\s*1\s*,\s*150000\s+do\s+end\s+if\s+os\.clock\s*\(\s*\)\s*-\s*\w+\s*>\s*5\.0\s+then\s+while\s+true\s+do\s+end\s+end\s*/g,

  /if\s+debug\s*~=\s*nil\s+and\s+debug\.getinfo\s+then\s+local\s+\w+\s*=\s*debug\.getinfo\s*\(\s*1\s*\)\s+if\s+\w+\.what\s*~=\s*"main"\s+and\s+\w+\.what\s*~=\s*"Lua"\s+then\s+while\s+true\s+do\s+end\s+end\s+end\s*/g,

  /if\s+debug\s+and\s+debug\.sethook\s+then\s+debug\.sethook\s*\([^)]+\)\s+end\s*/g,

  /local\s+\w+\s*,\s*\w+\s*=\s*pcall\s*\(function\s*\(\s*\)\s+error\s*\(\s*"[^"]+"\s*\)\s+end\s*\)\s+if\s+not\s+string\.find\s*\([^)]+\)\s+then\s+while\s+true\s+do\s+end\s+end\s*/g,

  /if\s+getmetatable\s*\(\s*_G\s*\)\s*~=\s*nil\s+then\s+while\s+true\s+do\s+end\s+end\s*/g,

  /if\s+type\s*\(\s*print\s*\)\s*~=\s*"function"\s+then\s+while\s+true\s+do\s+end\s+end\s*/g,
];

function stripAntiDebug(code) {
  let result = code;
  for (const pat of ANTI_DEBUG_PATTERNS) {
    pat.lastIndex = 0;
    result = result.replace(pat, ' ');
  }
  return collapseSpaces(result);
}

function stripIIFEGuards(code) {
  let result = code;
  let changed = true;
  let passes  = 0;

  while (changed && passes < 40) {
    changed = false;
    passes++;

    const next = result.replace(
      /local\s+(\w+)\s*=\s*function\s*\(\s*\)\s+local\s+\w+\s*=\s*error\s+if[^e]+end\s+end\s+\1\s*\(\s*\)\s*/g,
      () => { changed = true; return ' '; }
    );

    if (next !== result) result = next;
  }

  return collapseSpaces(result);
}

const OPAQUE_PREDICATES = [

  /if\s+not\s*\(\s*\d+\s*==\s*\d+\s*\)\s*then\s+local\s+\w+\s*=\s*1\s+end\s*/g,

  /if\s+type\s*\(\s*math\.pi\s*\)\s*==\s*"string"\s*then\s+local\s+_\s*=\s*1\s+end\s*/g,

  /if\s+type\s*\(\s*nil\s*\)\s*==\s*"number"\s*then\s+while\s+true\s+do\s+local\s+\w+\s*=\s*1\s+end\s+end\s*/g,



  /if\s+type\s*\(math\.pi\s*\)\s*==\s*"string"\s+then\s+local\s+_\s*=\s*\d+\s+end\s*/g,
];

function eliminateOpaquePredicates(code) {
  let result = code;
  for (const pat of OPAQUE_PREDICATES) {
    pat.lastIndex = 0;
    result = result.replace(pat, ' ');
  }
  return collapseSpaces(result);
}

const NOISE_PATTERNS = [

  /do\s+local\s+(\w+)\s*=\s*\{\}\s+\1\s*\[\s*"_"\s*\]\s*=\s*1\s+\1\s*=\s*nil\s+end\s*/g,

  /local\s+[IlvVIl]{2,}\d+\s*=\s*\d+\s+(?=local\s+[IlvVIl]{2,}\d+|if\s+|do\s+|for\s+|while\s+|end\b)/g,

  /local\s+[IlvVIl]{2,}\d+\s*=\s*string\.char\s*\(\d+\)\s+/g,

  /local\s+(?:KQ|HF|W8|SX|Rj|nT|pL|qZ|mV|xB|yC|wD)\d+\s*=\s*\d+\s+/g,
];

function stripNoiseCode(code) {
  let result = code;
  for (const pat of NOISE_PATTERNS) {
    pat.lastIndex = 0;
    result = result.replace(pat, ' ');
  }
  return collapseSpaces(result);
}

function linearizeCFF(code) {
  let result = code;
  let changed = true;
  let passes  = 0;

  while (changed && passes < 30) {
    changed = false;
    passes++;


    result = result.replace(
      /local\s+(\w+)\s*=\s*1\s+while\s+true\s+do\s+([\s\S]+?)\s+end\s+end/g,
      (fullMatch, stateVar, body) => {

        if (!body.includes(stateVar)) return fullMatch;

        const stateBlocks = [];

        const blockRx = new RegExp(
          `(?:if|elseif)\\s+${stateVar}\\s*==\\s*(\\d+)\\s+then\\s+([\\s\\S]*?)\\s+${stateVar}\\s*=\\s*\\d+`,
          'g'
        );

        let m;
        while ((m = blockRx.exec(body)) !== null) {
          const stateNum = parseInt(m[1], 10);
          const content  = m[2].trim();
          stateBlocks.push({ state: stateNum, content });
        }

        if (stateBlocks.length === 0) return fullMatch;

        stateBlocks.sort((a, b) => a.state - b.state);
        changed = true;
        return stateBlocks.map(b => b.content).join(' ');
      }
    );
  }

  return result;
}

function extractRealHandlerBody(block) {

  const handlerRx = /local\s+(\w+)\s*=\s*function\s*\(lM\)\s+local\s+lM\s*=\s*lM\s*;\s*([\s\S]+?)\s+end\s+(?=local\s+\w+\s*=\s*function|local\s+\w+\s*=\s*\{)/g;
  const handlers  = [];
  let m;

  while ((m = handlerRx.exec(block)) !== null) {
    const name = m[1];
    const body = m[2].trim();

    const isFake = /return\s+nil\s*$/.test(body);
    handlers.push({ name, body, isFake });
  }

  const real = handlers.find(h => !h.isFake);
  if (!real) return block;

  return real.body;
}

function peelSingleVMLayer(code) {

  if (!code.includes('local lM={}')) return null;

  const inner = extractRealHandlerBody(code);
  if (inner === code) return null;

  return inner;
}

function unwrapVMLayers(code, ctx) {
  ctx.depth = 0;
  let current = code;

  while (ctx.depth < MAX_UNWRAP_DEPTH) {
    const inner = peelSingleVMLayer(current);
    if (!inner || inner === current) break;
    current = inner;
    ctx.depth++;
  }

  return current;
}

function peelFragileVMLayer(code) {
  if (!code.includes('VM corrupted')) return null;


  const fragileRx = /local\s+(\w+)\s*=\s*function\s*\((\w+)\)\s+local\s+\w+\s*=\s*"[^"]*"\s+if\s+\2\s*\[\s*1\s*\]\s*~=\s*nil\s+then\s+error\s*\(\s*"VM corrupted"\s*\)\s+end\s+([\s\S]+?)\s+end\s+(?=local)/;
  const m = code.match(fragileRx);
  if (!m) return null;

  const body = m[3].trim();

  const cleaned = stripNoiseCode(eliminateOpaquePredicates(body));
  return cleaned;
}

function unwrapFragileVMLayers(code, ctx) {
  ctx.fragileDepth = 0;
  let current = code;

  while (ctx.fragileDepth < MAX_UNWRAP_DEPTH) {
    const inner = peelFragileVMLayer(current);
    if (!inner || inner === current) break;
    current = inner;
    ctx.fragileDepth++;
  }

  return current;
}

const IL_NAME_RX   = /\b([IlvV]{2,}\d+|[IlvV1][IlvV1]{1,}\d+)\b/g;

const HAND_NAME_RX = /\b(KQ|HF|W8|SX|Rj|nT|pL|qZ|mV|xB|yC|wD)\d{1,2}\b/g;

function normalizeObfuscatedNames(code) {
  const renameMap = new Map();
  let varCtr  = 1;
  let hndCtr  = 1;

  let m;
  IL_NAME_RX.lastIndex = 0;
  while ((m = IL_NAME_RX.exec(code)) !== null) {
    if (!renameMap.has(m[0])) renameMap.set(m[0], `_v${varCtr++}`);
  }

  HAND_NAME_RX.lastIndex = 0;
  while ((m = HAND_NAME_RX.exec(code)) !== null) {
    if (!renameMap.has(m[0])) renameMap.set(m[0], `_h${hndCtr++}`);
  }


  const sorted = [...renameMap.entries()].sort((a, b) => b[0].length - a[0].length);
  let result = code;
  for (const [original, replacement] of sorted) {

    const rx = new RegExp(`\\b${original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    result = result.replace(rx, replacement);
  }

  return { code: result, renameMap };
}

function isHttpUrl(s) {
  if (!s) return false;
  return /^https?:\/\/[^\s"']+/.test(s.trim());
}

function wrapHttpPayload(url) {
  return `loadstring(game:HttpGet("${url.trim()}"))()`;
}

function formatLua(code) {
  if (!code) return '';

  let s = code.replace(/\s+/g, ' ').trim();

  const newlineBefore = [
    'local ', 'function ', 'if ', 'else', 'elseif ', 'end',
    'for ', 'while ', 'do ', 'repeat', 'until ', 'return',
    'break', '--'
  ];

  for (const kw of newlineBefore) {
    const rx = new RegExp(`(?<![\\w])(?=${kw.replace(/ /g, '\\s*')})`, 'g');
    s = s.replace(rx, '\n');
  }

  const lines  = s.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const result = [];
  let depth    = 0;
  const INDENT = '  ';

  for (const line of lines) {

    if (/^(end\b|else\b|until\b|elseif\b)/.test(line)) depth = Math.max(0, depth - 1);

    result.push(INDENT.repeat(depth) + line);

    if (/\b(do|then|repeat|function\s*\()/.test(line) && !/\bend\b/.test(line)) {
      depth++;
    }
    if (/^else\b/.test(line)) depth++;
    if (/^function\b/.test(line) && !/\bend\b/.test(line)) depth++;
  }

  return result.join('\n');
}

function analyzeObfuscatedCode(code) {
  const hasFragileVM   = /error\s*\(\s*"VM corrupted"\s*\)/.test(code);
  const hasTrueVM      = /local\s+_pool\s*=/.test(code) || /local\s+_order\s*=/.test(code);
  const vmLayerCount   = (code.match(/local\s+lM\s*=\s*\{\}/g) || []).length;
  const fragileCount   = (code.match(/VM corrupted/g) || []).length;
  const hasHttpGet     = /HttpGet/i.test(code);
  const hasLoadstring  = /loadstring/.test(code);
  const hasAntiDebug   = /os\.clock/.test(code) && /150000/.test(code);
  const hasIIFEGuards  = /local\s+\w+\s*=\s*function\s*\(\s*\)\s+local\s+\w+\s*=\s*error/.test(code);
  const hasStringChar  = /string\.char\s*\(/.test(code);
  const hasHeavyMath   = /\(\(\(\(\(/.test(code);
  const hasCFF         = /while\s+true\s+do/.test(code) && /elseif\s+\w+\s*==/.test(code);
  const inputSize      = Buffer.byteLength(code, 'utf8');

  return {
    mode:           hasFragileVM ? 'diabolical' : 'normal',
    inputSizeBytes: inputSize,
    vmLayerCount,
    fragileVMLayers: fragileCount,
    hasTrueVM,
    hasHttpGet,
    hasLoadstring,
    hasAntiDebug,
    hasIIFEGuards,
    hasStringChar,
    hasHeavyMath,
    hasCFF,
    estimatedComplexity: (
      vmLayerCount > 10 || fragileCount > 5 ? 'HIGH' :
      vmLayerCount > 3  || fragileCount > 0 ? 'MEDIUM' : 'LOW'
    )
  };
}

function collapseSpaces(s) {
  return s.replace(/  +/g, ' ').trim();
}

function stripObfuscatorHeader(code) {
  return code
    .replace(/--\[\[\s*this code it's protected by v+mer obfoscator\s*\]\]\s*/gi, '')
    .replace(/--\[\[\s*this code.*?obfoscator.*?\]\]\s*/gi, '')
    .trim();
}

function looksLikeLua(s) {
  if (!s || s.length < 5) return false;

  return /\b(local|function|end|if|then|for|while|do|return|nil|true|false)\b/.test(s);
}

function deobfuscate(obfuscatedCode, opts = {}) {
  const { format = true, verbose = false } = opts;
  const startTime = Date.now();
  const log       = [];
  let recursionDepth = 0;

  const info = (msg)  => { log.push(`[INFO]  ${msg}`); };
  const warn = (msg)  => { log.push(`[WARN]  ${msg}`); };
  const debug = (msg) => { if (verbose) log.push(`[DEBUG] ${msg}`); };

  if (!obfuscatedCode || typeof obfuscatedCode !== 'string') {
    return { success: false, error: 'Input must be a non-empty string.', log, stats: {} };
  }
  if (obfuscatedCode.trim().length === 0) {
    return { success: false, error: 'Input is empty.', log, stats: {} };
  }

  info(`Input size: ${obfuscatedCode.length} chars / ${Buffer.byteLength(obfuscatedCode, 'utf8')} bytes`);

  const analysis = analyzeObfuscatedCode(obfuscatedCode);
  info(`Detected mode: ${analysis.mode}`);
  info(`VM layers found: ${analysis.vmLayerCount}`);
  info(`Fragile VM mentions: ${analysis.fragileVMLayers}`);
  info(`Complexity: ${analysis.estimatedComplexity}`);
  debug(`Full analysis: ${JSON.stringify(analysis)}`);

  let code = obfuscatedCode;

  code = stripObfuscatorHeader(code);
  debug('Stripped obfuscator header comment.');

  const beforeAD = code.length;
  code = stripAntiDebug(code);
  debug(`Anti-debug stripped: ${beforeAD - code.length} chars removed.`);

  const beforeGuards = code.length;
  code = stripIIFEGuards(code);
  debug(`IIFE guards stripped: ${beforeGuards - code.length} chars removed.`);

  const beforeMath = code.length;
  code = simplifyMathExpressions(code);
  code = simplifyMBAPatterns(code);
  debug(`Math simplification: ${beforeMath - code.length} chars removed.`);

  const beforeSC = code.length;
  code = decodeStringChar(code);
  debug(`string.char decoded: ${beforeSC - code.length} chars removed.`);

  code = resolveGetfenvStrings(code);
  debug('getfenv() identifiers resolved.');

  code = eliminateOpaquePredicates(code);
  code = stripNoiseCode(code);
  debug('Opaque predicates and noise removed.');

  const fragileCtx = { fragileDepth: 0 };
  if (analysis.mode === 'diabolical') {
    code = unwrapFragileVMLayers(code, fragileCtx);
    info(`Peeled ${fragileCtx.fragileDepth} Fragile-VM layers.`);
  }

  const vmCtx = { depth: 0 };
  code = unwrapVMLayers(code, vmCtx);
  info(`Unwrapped ${vmCtx.depth} SingleVM dispatch layers.`);

  code = linearizeCFF(code);
  debug('CFF state machines linearised.');

  code = simplifyMathExpressions(code);
  code = decodeStringChar(code);
  code = resolveGetfenvStrings(code);
  code = collapseSpaces(code);
  debug('Second-pass math/string simplification done.');

  info('Attempting Rolling XOR-Affine cipher decryption...');
  let decryptResult = decryptVMPayload(code);

  if (!decryptResult.success) {
    warn(`First decryption attempt failed: ${decryptResult.error}`);
    warn('Applying deep simplification and retrying...');
    let deepCode = code;
    for (let i = 0; i < 3; i++) {
      deepCode = simplifyMathExpressions(deepCode);
      deepCode = decodeStringChar(deepCode);
    }
    decryptResult = decryptVMPayload(deepCode);
  }

  let finalCode;
  let decryptionSuccess = false;

  if (decryptResult.success) {
    decryptionSuccess = true;
    const payload = decryptResult.payload.trim();
    info(`Payload decrypted: ${payload.length} chars (seed=${decryptResult.metadata.seed}, salt=${decryptResult.metadata.saltVal})`);
    if (decryptResult.metadata.warnings && decryptResult.metadata.warnings.length > 0) {
      for (const w of decryptResult.metadata.warnings) warn(w);
    }

    if (isHttpUrl(payload)) {
      info('Payload is an HttpGet URL â€” reconstructing original call.');
      finalCode = wrapHttpPayload(payload);
    } else if (looksLikeLua(payload)) {

      const innerAnalysis = analyzeObfuscatedCode(payload);
      if (innerAnalysis.vmLayerCount > 0 || innerAnalysis.hasTrueVM) {
        info('Payload is further obfuscated â€” recursing...');
        recursionDepth++;
        if (recursionDepth < 5) {
          const inner = deobfuscate(payload, opts);
          if (inner.success && inner.code) {
            finalCode = inner.code;
            for (const l of inner.log) log.push(`  [INNER] ${l}`);
            info('Recursive deobfuscation succeeded.');
          } else {
            warn('Recursive deobfuscation failed; returning raw payload.');
            finalCode = payload;
          }
          recursionDepth--;
        } else {
          warn('Max recursion depth reached; returning raw payload.');
          finalCode = payload;
        }
      } else {
        finalCode = payload;
      }
    } else {
      warn('Decrypted payload does not look like Lua source; it may be encoded or binary.');
      finalCode = payload;
    }
  } else {
    warn(`Decryption failed: ${decryptResult.error}`);
    warn('Returning best-effort structural reconstruction.');

    finalCode = normalizeObfuscatedNames(code).code;
  }

  if (finalCode) {

    if (!decryptionSuccess) {
      finalCode = normalizeObfuscatedNames(finalCode).code;
    }
    if (format && looksLikeLua(finalCode)) {
      finalCode = formatLua(finalCode);
    }
  }

  const elapsed = Date.now() - startTime;
  info(`Done in ${elapsed} ms. Output: ${(finalCode || '').length} chars.`);

  const techniques = [];
  if (analysis.hasHeavyMath)            techniques.push('Heavy math obfuscation');
  if (analysis.hasStringChar)           techniques.push('string.char encoding');
  if (analysis.hasTrueVM)               techniques.push('True VM with XOR-Affine cipher');
  if (analysis.vmLayerCount > 0)        techniques.push(`${analysis.vmLayerCount} VM dispatch layers`);
  if (analysis.fragileVMLayers > 0)     techniques.push(`${analysis.fragileVMLayers} Fragile-VM layers`);
  if (analysis.hasCFF)                  techniques.push('Control Flow Flattening');
  if (analysis.hasAntiDebug)            techniques.push('Anti-debug timing checks');
  if (analysis.hasIIFEGuards)           techniques.push('IIFE integrity guards');
  if (analysis.hasLoadstring)           techniques.push('loadstring payload');
  if (analysis.hasHttpGet)              techniques.push('HttpGet network call');
  if (techniques.length === 0)          techniques.push('Generic obfuscation');

  const weakPoints = [];
  if (analysis.hasHeavyMath)  weakPoints.push('Math expressions are deterministic â€” fully reversible');
  if (analysis.hasStringChar) weakPoints.push('string.char args reduce to literals after math eval');
  if (analysis.hasTrueVM)     weakPoints.push('XOR-Affine cipher uses static seed/salt â€” fully decryptable');
  if (analysis.hasCFF)        weakPoints.push('CFF state machine has finite states â€” linearizable');
  if (analysis.hasAntiDebug)  weakPoints.push('Anti-debug uses os.clock â€” strippable by pattern');
  if (analysis.hasIIFEGuards) weakPoints.push('Integrity guards rely on error("!") â€” pattern matchable');
  if (weakPoints.length === 0) weakPoints.push('Static analysis exposes the payload directly');

  let status = 'good';
  if (!decryptionSuccess) {
    status = analysis.estimatedComplexity === 'HIGH' ? 'bad' : 'medium';
  }

  analysis.techniques = techniques;
  analysis.weakPoints = weakPoints;
  analysis.status     = status;

  return {
    success:    true,
    code:       finalCode || '',
    timeMs:     elapsed,
    analysis,
    log,
    stats: {
      inputSize:          obfuscatedCode.length,
      outputSize:         (finalCode || '').length,
      timeMs:             elapsed,
      vmLayersUnwrapped:  vmCtx.depth,
      fragileLayersUnwrapped: fragileCtx.fragileDepth,
      decryptionSuccess,
      payloadLength:      decryptResult.success ? decryptResult.metadata.payloadLength : 0
    }
  };
}

function printHelp() {
  console.log(`
â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—
â•‘          CodeVault / vmmer Lua Deobfuscator  v${VERSION}                      â•‘
â•‘          Supports: Normal (18x VM) and Diabolical (45x FragileVM)         â•‘
â• â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•£
â•‘  Usage:                                                                   â•‘
â•‘    node deobfuscator.js <input.lua> [output.lua] [options]                â•‘
â•‘    node deobfuscator.js --stdin [options]                                 â•‘
â•‘    node deobfuscator.js --analyze <input.lua>                             â•‘
â• â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•£
â•‘  Options:                                                                 â•‘
â•‘    -h, --help       Show this help                                        â•‘
â•‘    -v, --verbose    Show detailed processing log                          â•‘
â•‘    -a, --analyze    Analyse only (no decryption)                          â•‘
â•‘    --stdin          Read input from stdin                                 â•‘
â•‘    --no-format      Skip Lua beautifier                                   â•‘
â•‘    --json           Output full result as JSON                            â•‘
â• â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•£
â•‘  20 Deobfuscation Techniques:                                             â•‘
â•‘  01 heavyMath arithmetic evaluator    11 Opaque predicate eliminator      â•‘
â•‘  02 MBA simplifier                    12 Tarpit dead-loop stripper        â•‘
â•‘  03 string.char() decoder             13 Symbol waterfall remover         â•‘
â•‘  04 getfenv() string resolver         14 CFF state-machine linearizer     â•‘
â•‘  05 Rolling XOR-Affine decryptor      15 VM dispatch table analyzer       â•‘
â•‘  06 Fake chunk pool decoy remover     16 Recursive VM layer unwrapper     â•‘
â•‘  07 Chunk reassembler                 17 Fragile-VM layer peeler          â•‘
â•‘  08 Anti-debug timing stripper        18 IL_POOL name normalizer          â•‘
â•‘  09 debug.getinfo guard remover       19 HttpGet URL extractor            â•‘
â•‘  10 IIFE integrity guard stripper     20 Lua code formatter               â•‘
â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  `);
}

function runCLI() {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  const verbose    = argv.includes('--verbose')   || argv.includes('-v');
  const analyzeOnly= argv.includes('--analyze')   || argv.includes('-a');
  const fromStdin  = argv.includes('--stdin');
  const asJson     = argv.includes('--json');
  const noFormat   = argv.includes('--no-format');

  const fileArgs   = argv.filter(a => !a.startsWith('-'));

  let inputCode    = '';
  let inputFile    = '';
  let outputFile   = '';

  if (fromStdin) {
    try {
      inputCode = fs.readFileSync('/dev/stdin', 'utf8');
    } catch {
      inputCode = fs.readFileSync(0, 'utf8');
    }
  } else {
    if (fileArgs.length === 0) {
      console.error('Error: No input file specified. Use --help for usage.');
      process.exit(1);
    }
    inputFile  = fileArgs[0];
    outputFile = fileArgs[1] || '';

    if (!fs.existsSync(inputFile)) {
      console.error(`Error: File not found: ${inputFile}`);
      process.exit(1);
    }
    inputCode = fs.readFileSync(inputFile, 'utf8');
  }

  if (!inputCode.trim()) {
    console.error('Error: Input is empty.');
    process.exit(1);
  }

  process.stderr.write(
    `[*] CodeVault Deobfuscator v${VERSION}\n` +
    `[*] Input: ${inputFile || 'stdin'} (${inputCode.length} chars)\n`
  );

  if (analyzeOnly) {
    const analysis = analyzeObfuscatedCode(inputCode);
    console.log(JSON.stringify(analysis, null, 2));
    process.exit(0);
  }

  const result = deobfuscate(inputCode, { format: !noFormat, verbose });

  if (verbose) {
    for (const line of result.log) {
      process.stderr.write(line + '\n');
    }
  }

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.code) {
      if (outputFile) {
        fs.writeFileSync(outputFile, result.code, 'utf8');
        process.stderr.write(
          `[âœ“] Output â†’ ${outputFile} (${result.code.length} chars)\n` +
          `[âœ“] VM layers unwrapped : ${result.stats.vmLayersUnwrapped}\n` +
          `[âœ“] Fragile layers peeled: ${result.stats.fragileLayersUnwrapped}\n` +
          `[âœ“] Decryption           : ${result.stats.decryptionSuccess ? 'SUCCESS âœ“' : 'PARTIAL âš '}\n` +
          `[âœ“] Time                 : ${result.stats.timeMs} ms\n`
        );
      } else {
        console.log(result.code);
      }
    } else {
      process.stderr.write('[âœ—] Deobfuscation did not produce output.\n');
      if (result.error) process.stderr.write(`    Error: ${result.error}\n`);
      process.exit(1);
    }
  }
}

module.exports = {

  deobfuscate,

  techniques: {
    safeEvalMath,
    simplifyMathExpressions,
    simplifyMBAPatterns,
    decodeStringChar,
    resolveGetfenvStrings,
    decryptVMPayload,
    stripAntiDebug,
    stripIIFEGuards,
    eliminateOpaquePredicates,
    stripNoiseCode,
    linearizeCFF,
    extractRealHandlerBody,
    peelSingleVMLayer,
    peelFragileVMLayer,
    unwrapVMLayers,
    unwrapFragileVMLayers,
    normalizeObfuscatedNames,
    isHttpUrl,
    wrapHttpPayload,
    formatLua,
  },

  utils: {
    analyzeObfuscatedCode,
    splitTopLevelCommas,
    extractNumericArray,
    looksLikeLua,
    collapseSpaces,
  }
};

if (require.main === module) {
  runCLI();
}
