/**
 * deobfuscator.js
 * Dynamic Lua deobfuscation engine — Node.js port of the Python original.
 * Handles Luau compound-assignment normalisation, MockEnv injection,
 * subprocess execution and structured report generation.
 */

"use strict";

const fs        = require("fs");
const path      = require("path");
const os        = require("os");
const { spawn } = require("child_process");

// ─── Configuration ────────────────────────────────────────────────────────────

const COMPOUND_ASSIGNMENT_OPERATORS = ["+=", "-=", "*=", "/=", "%=", "..="];

const RELEVANT_PREFIXES = [
  "ACCESSED",
  "CALL_RESULT",
  "local Constants =",
  "URL DETECTED",
  "SET GLOBAL",
  "UNPACK CALLED",
  "CAPTURED CHUNK",
  "CLOSURE",
  "TRACE_PRINT",
  "PROP_SET",
  "LOADSTRING",
];

const EXECUTION_TIMEOUT_MS = 20_000;

// Path to the Lua 5.1 binary (override via env var LUA_BIN)
const LUA_BIN = process.env.LUA_BIN || path.join("lua_bin", "lua5.1.exe");

// ─── Luau Syntax Normalisation ────────────────────────────────────────────────

/**
 * Walk backwards from `operatorIndex` to find the start of the LHS expression.
 * Handles chained table accesses (a.b[c].d) and simple identifiers.
 *
 * @param {string} content
 * @param {number} operatorIndex  – index of the first char of the operator
 * @returns {number}              – index of the first char of the LHS
 */
function findCompoundLhsStart(content, operatorIndex) {
  let idx = operatorIndex - 1;

  // Skip trailing whitespace before the operator
  while (idx >= 0 && /\s/.test(content[idx])) idx--;

  // Consume bracket subscripts: [...]
  while (idx >= 0 && content[idx] === "]") {
    let depth = 1;
    idx--;
    while (idx >= 0 && depth > 0) {
      if (content[idx] === "]") depth++;
      else if (content[idx] === "[") depth--;
      idx--;
    }
  }

  // Consume identifier characters
  while (idx >= 0 && /[\w]/.test(content[idx])) idx--;

  // Consume chained member accesses: .ident, .[subscript]
  while (idx >= 0 && content[idx] === ".") {
    idx--;
    while (idx >= 0 && content[idx] === "]") {
      let depth = 1;
      idx--;
      while (idx >= 0 && depth > 0) {
        if (content[idx] === "]") depth++;
        else if (content[idx] === "[") depth--;
        idx--;
      }
    }
    while (idx >= 0 && /[\w]/.test(content[idx])) idx--;
  }

  return idx + 1;
}

/**
 * Walk forward from `rhsStart` to find the end of the RHS expression.
 * Stops at top-level `;`, `,`, newline, or unmatched `)` / `}`.
 *
 * @param {string} content
 * @param {number} rhsStart
 * @returns {number}  – exclusive end index of the RHS
 */
function findCompoundRhsEnd(content, rhsStart) {
  let idx           = rhsStart;
  const len         = content.length;
  let bracketDepth  = 0;
  let parenDepth    = 0;
  let braceDepth    = 0;
  let quote         = null;

  // Skip leading whitespace
  while (idx < len && /\s/.test(content[idx])) idx++;

  while (idx < len) {
    const ch = content[idx];

    if (quote) {
      if (ch === "\\") { idx += 2; continue; }
      if (ch === quote) quote = null;
      idx++;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      idx++;
      continue;
    }

    if      (ch === "[") bracketDepth++;
    else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === "(") parenDepth++;
    else if (ch === ")") {
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) break;
      parenDepth = Math.max(0, parenDepth - 1);
    }
    else if (ch === "{") braceDepth++;
    else if (ch === "}") {
      if (braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) break;
      braceDepth = Math.max(0, braceDepth - 1);
    }
    else if (bracketDepth === 0 && parenDepth === 0 && braceDepth === 0) {
      if (";,\n\r".includes(ch)) break;
      if (/\s/.test(ch))         break;
    }

    idx++;
  }

  return idx;
}

/**
 * Rewrite Luau compound assignments to plain Lua 5.1 syntax.
 * e.g.  `x += 1`  →  `x = x + 1`
 *
 * @param {string} content
 * @returns {string}
 */
function normalizeLuauSyntax(content) {
  const replacements = [];
  let idx = 0;

  while (idx < content.length) {
    let matchedOp = null;
    for (const op of COMPOUND_ASSIGNMENT_OPERATORS) {
      if (content.startsWith(op, idx)) { matchedOp = op; break; }
    }

    if (!matchedOp) { idx++; continue; }

    const lhsStart = findCompoundLhsStart(content, idx);
    const rhsStart = idx + matchedOp.length;
    const rhsEnd   = findCompoundRhsEnd(content, rhsStart);

    const lhs = content.slice(lhsStart, idx).trim();
    const rhs = content.slice(rhsStart, rhsEnd).trim();

    if (lhs && rhs) {
      const arithmeticOp = matchedOp.slice(0, -1); // strip trailing '='
      replacements.push({ start: lhsStart, end: rhsEnd, replacement: `${lhs} = ${lhs} ${arithmeticOp} ${rhs}` });
    }
    idx = rhsEnd;
  }

  if (replacements.length === 0) return content;

  // Apply in reverse so indices remain valid
  let rewritten = content;
  for (const { start, end, replacement } of replacements.reverse()) {
    rewritten = rewritten.slice(0, start) + replacement + rewritten.slice(end);
  }
  return rewritten;
}

// ─── MockEnv Lua Block ────────────────────────────────────────────────────────

/**
 * Returns the Lua source block that provides the mock execution environment.
 * Identical in behaviour to the Python original.
 *
 * @returns {string}
 */
function getMockEnvCode() {
  return /* lua */ `
local real_type = type
local real_tonumber = tonumber
local real_unpack = unpack
local real_concat = table.concat
local real_tostring = tostring
local real_print = print

local _WAIT_COUNT = 0
local _LOOP_COUNTER = 0
local _MAX_LOOPS = 150
local _LOOP_BODIES = {}

local function _check_loop()
    _LOOP_COUNTER = _LOOP_COUNTER + 1
    if _LOOP_COUNTER > _MAX_LOOPS then return false end
    return true
end

local function type(v)
    local mt = getmetatable(v)
    if mt and mt.__is_mock_dummy then return "userdata" end
    return real_type(v)
end

local function typeof(v)
    local mt = getmetatable(v)
    if mt and mt.__is_mock_dummy then return "Instance" end
    return type(v)
end

local function tonumber(v, base)
    if type(v) == "userdata" or (type(v) == "table" and getmetatable(v) and getmetatable(v).__is_mock_dummy) then
        return 1
    end
    return real_tonumber(v, base)
end

local function unpack(t, i, j)
    if real_type(t) == "table" then
        local looks_like_chunk = true
        for k, v in pairs(t) do
            if real_type(k) ~= "number" then looks_like_chunk = false break end
        end
        if looks_like_chunk and #t > 0 then
            print("UNPACK CALLED WITH TABLE (Potential Chunk): size=" .. #t)
            local success, res = pcall(real_concat, t, ",")
            if success then
                print("CAPTURED CHUNK STRING: " .. res)
                if res:match("http") or res:match("www") then
                    print("URL DETECTED IN UNPACK --> " .. res:match("https?://[%w%.%-%/]+"))
                end
            end
        end
    end
    return real_unpack(t, i, j)
end

local function table_concat(t, sep, i, j)
    local res = real_concat(t, sep, i, j)
    if real_type(res) == "string" and (res:match("http") or res:match("www")) then
        print("URL DETECTED IN CONCAT --> " .. res:match("https?://[%w%.%-%/]+"))
    end
    return res
end

local function escape_lua_string(s)
    local parts = {'"'}
    for i = 1, #s do
        local byte = string.byte(s, i)
        if byte == 92 then table.insert(parts, "\\\\")
        elseif byte == 34 then table.insert(parts, '\\"')
        elseif byte == 10 then table.insert(parts, "\\n")
        elseif byte == 13 then table.insert(parts, "\\r")
        elseif byte == 9  then table.insert(parts, "\\t")
        elseif byte >= 32 and byte <= 126 then table.insert(parts, string.char(byte))
        else table.insert(parts, string.format("\\%03d", byte)) end
    end
    table.insert(parts, '"')
    return table.concat(parts)
end

local function recursive_tostring(v, depth)
    if depth == nil then depth = 0 end
    if depth > 2 then return tostring(v) end
    if real_type(v) == "string" then return escape_lua_string(v)
    elseif real_type(v) == "number" then
        if v == math.floor(v) and v >= -2147483648 and v <= 2147483647 then return tostring(math.floor(v)) end
        return tostring(v)
    elseif real_type(v) == "boolean" then return tostring(v)
    elseif v == nil then return "nil"
    elseif real_type(v) == "table" then
        if getmetatable(v) and getmetatable(v).__is_mock_dummy then return tostring(v) end
        local parts = {}
        local keys = {}
        for k in pairs(v) do table.insert(keys, k) end
        table.sort(keys, function(a,b) return tostring(a) < tostring(b) end)
        for _, k in ipairs(keys) do
            local val = v[k]
            local k_str = tostring(k)
            if real_type(k) == "string" then k_str = '["' .. k .. '"]' end
            table.insert(parts, k_str .. " = " .. recursive_tostring(val, depth + 1))
        end
        return "{" .. real_concat(parts, ", ") .. "}"
    elseif real_type(v) == "function" then return tostring(v)
    else return tostring(v) end
end

local function create_dummy(name)
    local d = {}
    local mt = {
        __is_mock_dummy = true,
        __index = function(_, k)
            print("ACCESSED --> " .. name .. "." .. k)
            if k == "HttpGet" or k == "HttpGetAsync" then
                return function(_, url, ...)
                    print("URL DETECTED --> " .. tostring(url))
                    return create_dummy("HttpGetResult")
                end
            end
            return create_dummy(name .. "." .. k)
        end,
        __newindex = function(_, k, v)
            local val_str = recursive_tostring(v, 0)
            print("PROP_SET --> " .. name .. "." .. k .. " = " .. val_str)
        end,
        __call = function(_, ...)
            local args = {...}
            local arg_str = ""
            for i, v in ipairs(args) do
                if i > 1 then arg_str = arg_str .. ", " end
                arg_str = arg_str .. recursive_tostring(v)
            end
            local var_name = name:gsub("%.", "_") .. "_" .. math.random(100, 999)
            print("CALL_RESULT --> local " .. var_name .. " = " .. name .. "(" .. arg_str .. ")")
            if name == "task.wait" or name == "wait" then
                _WAIT_COUNT = _WAIT_COUNT + 1
                if _WAIT_COUNT > 10 then error("Too many waits!") end
            end
            for i, v in ipairs(args) do
                if real_type(v) == "function" then
                    print("--- ENTERING CLOSURE FOR " .. name .. " ---")
                    local success, err = pcall(v,
                        create_dummy("arg1"), create_dummy("arg2"),
                        create_dummy("arg3"), create_dummy("arg4"))
                    if not success then print("-- CLOSURE ERROR: " .. tostring(err)) end
                    print("--- EXITING CLOSURE FOR " .. name .. " ---")
                end
            end
            return create_dummy(var_name)
        end,
        __tostring  = function() return name end,
        __concat    = function(a, b) return tostring(a) .. tostring(b) end,
        __add       = function(a, b) return create_dummy("("..tostring(a).."+"..tostring(b)..")") end,
        __sub       = function(a, b) return create_dummy("("..tostring(a).."-"..tostring(b)..")") end,
        __mul       = function(a, b) return create_dummy("("..tostring(a).."*"..tostring(b)..")") end,
        __div       = function(a, b) return create_dummy("("..tostring(a).."/"..tostring(b)..")") end,
        __mod       = function(a, b) return create_dummy("("..tostring(a).."%"..tostring(b)..")") end,
        __pow       = function(a, b) return create_dummy("("..tostring(a).."^"..tostring(b)..")") end,
        __unm       = function(a)    return create_dummy("-"..tostring(a)) end,
        __lt        = function(a, b) return false end,
        __le        = function(a, b) return false end,
        __eq        = function(a, b) return false end,
        __len       = function(a)    return 2 end,
    }
    setmetatable(d, mt)
    return d
end

local function mock_pairs(t)
    local mt = getmetatable(t)
    if mt and mt.__is_mock_dummy then
        local i = 0
        return function(...)
            i = i + 1
            if i <= 1 then return i, create_dummy(tostring(t).."_v"..i) end
            return nil
        end
    end
    return pairs(t)
end

local function mock_ipairs(t)
    local mt = getmetatable(t)
    if mt and mt.__is_mock_dummy then
        local i = 0
        return function(...)
            i = i + 1
            if i <= 1 then return i, create_dummy(tostring(t).."_v"..i) end
            return nil
        end
    end
    return ipairs(t)
end

local MockEnv = {}
local safe_globals = {
    ["string"]   = string,
    ["table"]    = { insert = table.insert, remove = table.remove, sort = table.sort, concat = table_concat, maxn = table.maxn },
    ["math"]     = math,
    ["pairs"]    = mock_pairs,
    ["ipairs"]   = mock_ipairs,
    ["select"]   = select,
    ["unpack"]   = unpack,
    ["tonumber"] = tonumber,
    ["tostring"] = tostring,
    ["type"]     = type,
    ["typeof"]   = typeof,
    ["pcall"]    = pcall,
    ["xpcall"]   = xpcall,
    ["getfenv"]  = getfenv,
    ["setmetatable"] = setmetatable,
    ["getmetatable"] = getmetatable,
    ["error"]    = error,
    ["assert"]   = assert,
    ["next"]     = next,
    ["print"]    = function(...)
        local args = {...}
        local parts = {}
        for i,v in ipairs(args) do table.insert(parts, tostring(v)) end
        print("TRACE_PRINT --> " .. table.concat(parts, "\\t"))
    end,
    ["_VERSION"] = _VERSION,
    ["rawset"]   = rawset,
    ["rawget"]   = rawget,
    ["os"]       = os, ["io"] = io, ["package"] = package, ["debug"] = debug,
    ["dofile"]   = dofile, ["loadfile"] = loadfile,
    ["loadstring"] = function(s)
        print("LOADSTRING DETECTED: size=" .. tostring(#s))
        print("LOADSTRING CONTENT START")
        print(s)
        print("LOADSTRING CONTENT END")
        return function() print("DUMMY FUNC CALLED") end
    end,
}

local _exploit_funcs = {
    "getgc","getinstances","getnilinstances","getloadedmodules","getconnections",
    "firesignal","fireclickdetector","firetouchinterest","isnetworkowner",
    "gethiddenproperty","sethiddenproperty","setsimulationradius",
    "rconsoleprint","rconsolewarn","rconsoleerr","rconsoleinfo","rconsolename","rconsoleclear",
    "consoleprint","consolewarn","consoleerr","consoleinfo","consolename","consoleclear",
    "warn","print","error","debug","clonefunction","hookfunction","newcclosure",
    "replaceclosure","restoreclosure","islclosure","iscclosure","checkcaller",
    "getnamecallmethod","setnamecallmethod","getrawmetatable","setrawmetatable",
    "setreadonly","isreadonly","iswindowactive","keypress","keyrelease",
    "mouse1click","mouse1press","mouse1release","mousescroll","mousemoverel","mousemoveabs",
    "hookmetamethod","getcallingscript","makefolder","writefile","readfile","appendfile",
    "loadfile","listfiles","isfile","isfolder","delfile","delfolder","dofile",
    "bit","bit32","Vector2","Vector3","CFrame","UDim2","Color3","Instance","Ray",
    "Enum","BrickColor","NumberRange","NumberSequence","ColorSequence",
    "task","coroutine","Delay","delay","Spawn","spawn","Wait","wait",
    "workspace","Workspace","tick","time","elapsedTime","utf8",
}
local _exploit_set = {}
for _, v in ipairs(_exploit_funcs) do _exploit_set[v] = true end

setmetatable(MockEnv, {
    __index = function(t, k)
        if safe_globals[k] then return safe_globals[k] end
        if k == "game" then print("ACCESSED --> game"); return create_dummy("game") end
        if k == "getgenv" or k == "getrenv" or k == "getreg" then return function() return MockEnv end end
        if _exploit_set[k] then print("ACCESSED --> " .. k); return create_dummy(k) end
        print("ACCESSED (NIL) --> " .. k)
        return nil
    end,
    __newindex = function(t, k, v)
        local val_str
        if real_type(v) == "string" then val_str = '"' .. v .. '"'
        elseif real_type(v) == "number" or real_type(v) == "boolean" then val_str = tostring(v)
        else val_str = tostring(v) end
        print("SET GLOBAL --> " .. tostring(k) .. " = " .. val_str)
        rawset(t, k, v)
    end,
})

safe_globals["_G"]     = MockEnv
safe_globals["shared"] = MockEnv
`;
}

// ─── Core Deobfuscation Logic ─────────────────────────────────────────────────

/**
 * Identify the string-table variable name from the obfuscated source.
 *
 * @param {string} content
 * @returns {string|null}
 */
function detectVarName(content) {
  const m = content.match(/local ([a-zA-Z0-9_]+)=\{"/) ;
  return m ? m[1] : null;
}

/**
 * Build the Lua snippet that dumps the constants table to stdout.
 *
 * @param {string} varName
 * @returns {string}
 */
function buildDumperCode(varName) {
  return /* lua */ `
    print("--- CONSTANTS START ---")
    if ${varName} then
        local sorted_keys = {}
        for k in pairs(${varName}) do table.insert(sorted_keys, k) end
        table.sort(sorted_keys)
        local out = "local Constants = {"
        for i, k in ipairs(sorted_keys) do
            local v = ${varName}[k]
            local v_str = escape_lua_string(v)
            out = out .. " [" .. k .. "] = " .. v_str .. ","
        end
        out = out .. " }"
        print(out)
    end
    print("--- CONSTANTS END ---")
`;
}

/**
 * Determine the injection point: just before `return(function`.
 *
 * @param {string} content
 * @param {number} beforeIdx  – search limit (rfind behaviour)
 * @returns {number}
 */
function findReturnFunctionIdx(content, beforeIdx) {
  return content.lastIndexOf("return(function", beforeIdx);
}

/**
 * Replace getfenv patterns with MockEnv.
 *
 * @param {string} content
 * @returns {string}
 */
function replaceGetfenv(content) {
  // Specific combined form first
  content = content.replace(/getfenv\s+and\s+getfenv\(\)or\s+_ENV/g, "MockEnv");
  // Generic getfenv() standalone
  content = content.replace(/getfenv\s*\(\s*\)\s*or\s*_ENV/g, "MockEnv");
  return content;
}

/**
 * Spawn lua5.1 and collect stdout line-by-line with a hard timeout.
 *
 * @param {string} tempFilePath
 * @returns {Promise<string[]>}  – all stdout lines
 */
function runLua(tempFilePath) {
  return new Promise((resolve) => {
    const lines  = [];
    let   buffer = "";
    let   done   = false;

    const proc = spawn(LUA_BIN, [tempFilePath, "1"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = () => {
      if (done) return;
      done = true;
      if (buffer.trim()) lines.push(buffer.trim());
      resolve(lines);
    };

    const timer = setTimeout(() => {
      console.log("  [TIMEOUT] Killing Lua process after 20 s.");
      proc.kill();
      finish();
    }, EXECUTION_TIMEOUT_MS);

    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop(); // last fragment (may be incomplete)
      for (const line of parts) {
        lines.push(line);
        if (RELEVANT_PREFIXES.some((p) => line.includes(p))) {
          console.log("  " + line);
        }
      }
    });

    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) console.error("  [STDERR]", text);
    });

    proc.on("close", () => {
      clearTimeout(timer);
      finish();
    });

    proc.on("error", (err) => {
      console.error(`  [SPAWN ERROR] ${err.message}`);
      clearTimeout(timer);
      finish();
    });
  });
}

/**
 * Main deobfuscation routine for a single file.
 *
 * @param {string} filePath
 */
async function deobfuscateFile(filePath) {
  console.log(`\nProcessing: ${filePath}`);

  // Skip already-processed files
  if (filePath.includes(".deobf.") || filePath.includes(".report.")) {
    console.log("  Skipping processed file.");
    return;
  }

  // ── 1. Read source ────────────────────────────────────────────────────────
  let content;
  try {
    content = fs.readFileSync(filePath, { encoding: "utf8", flag: "r" });
  } catch (err) {
    console.error(`  [ERROR] Cannot read file: ${err.message}`);
    return;
  }

  // ── 2. Normalise Luau compound operators ──────────────────────────────────
  content = normalizeLuauSyntax(content);

  // ── 3. Detect string-table variable ──────────────────────────────────────
  const varName = detectVarName(content);
  if (!varName) {
    console.warn("  [WARN] Could not identify string-table variable. Proceeding without constant dumper.");
  }

  // ── 4. Find injection points ──────────────────────────────────────────────
  let idxArgs = content.lastIndexOf("(getfenv");
  if (idxArgs === -1) idxArgs = content.lastIndexOf("( getfenv");
  if (idxArgs === -1) idxArgs = content.length;

  const idxRet = findReturnFunctionIdx(content, idxArgs);
  if (idxRet === -1) {
    console.error("  [ERROR] Could not find return(function injection point.");
    return;
  }

  // ── 5. Build patched Lua source ───────────────────────────────────────────
  const mockEnv    = getMockEnvCode();
  const dumperCode = varName ? buildDumperCode(varName) : "";

  let patched = mockEnv + content.slice(0, idxRet) + dumperCode + content.slice(idxRet);
  patched     = replaceGetfenv(patched);

  // ── 6. Write temp file ────────────────────────────────────────────────────
  const tmpFile = path.join(os.tmpdir(), `deob_${Date.now()}_${Math.random().toString(36).slice(2)}.lua`);
  try {
    fs.writeFileSync(tmpFile, patched, "utf8");
  } catch (err) {
    console.error(`  [ERROR] Cannot write temp file: ${err.message}`);
    return;
  }

  // ── 7. Execute ────────────────────────────────────────────────────────────
  console.log("  Executing via Lua 5.1…");
  const stdoutLines = await runLua(tmpFile);

  // ── 8. Parse output ───────────────────────────────────────────────────────
  let   inConstants   = false;
  let   constantsStr  = "";
  const traceLines    = [];

  for (const line of stdoutLines) {
    if (line === "--- CONSTANTS START ---") { inConstants = true;  continue; }
    if (line === "--- CONSTANTS END ---")   { inConstants = false; continue; }

    if (inConstants) {
      constantsStr += line + "\n";
    } else if (RELEVANT_PREFIXES.some((p) => line.includes(p))) {
      traceLines.push(line);
    }
  }

  // ── 9. Write report ───────────────────────────────────────────────────────
  const reportFile = filePath + ".report.txt";
  const reportContent = [
    "--- DEOBFUSCATION REPORT ---",
    `File: ${filePath}`,
    "",
    "--- TRACE ---",
    ...traceLines,
    "",
    "--- CONSTANTS ---",
    constantsStr,
  ].join("\n");

  try {
    fs.writeFileSync(reportFile, reportContent, "utf8");
    console.log(`  Report saved → ${reportFile}`);
  } catch (err) {
    console.error(`  [ERROR] Cannot write report: ${err.message}`);
  }

  // ── 10. Cleanup temp file ─────────────────────────────────────────────────
  try { fs.unlinkSync(tmpFile); } catch (_) {}
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

/**
 * Process a single file or every .lua file inside a directory.
 *
 * @param {string} target  – file path or directory path
 */
async function main(target) {
  if (!target) {
    console.error("Usage: node deobfuscator.js <file.lua|directory>");
    process.exit(1);
  }

  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    console.error(`Invalid path: ${target}`);
    process.exit(1);
  }

  if (stat.isFile()) {
    await deobfuscateFile(target);
  } else if (stat.isDirectory()) {
    const files = fs.readdirSync(target)
      .filter((f) => f.endsWith(".lua") && !f.includes("temp_deob") && !f.includes(".report.txt") && !f.includes(".deobf."))
      .sort();

    if (files.length === 0) {
      console.log("No .lua files found in directory.");
      return;
    }

    for (const file of files) {
      await deobfuscateFile(path.join(target, file));
      console.log("-".repeat(60));
    }
  } else {
    console.error("Target must be a file or directory.");
    process.exit(1);
  }
}

// ─── Run ──────────────────────────────────────────────────────────────────────
const target = process.argv[2] || "obfuscated_scripts";
main(target).catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
