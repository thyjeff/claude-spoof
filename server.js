const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const express = require('express');
const fetch = require('node-fetch');
const http = require('http');
const https = require('https');
const fs = require('fs');

const PORT = parseInt(process.env.PROXY_PORT || '8080');
const SPOOF_MODEL = process.env.SPOOF_MODEL || 'claude-sonnet-4-20250514';
const PROXY_AUTH_TOKEN = process.env.PROXY_AUTH_TOKEN || '';
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || '120000');
const PID_FILE = path.resolve(__dirname, 'proxy.pid');
const CONFIG_FILE = path.resolve(__dirname, process.env.CONFIG_FILE || 'config.json');

// Connection pool — reuses TCP+TLS across requests (dramatically faster)
const AGENT_HTTP = new http.Agent({ keepAlive: true, maxSockets: 64, timeout: TIMEOUT_MS });
const AGENT_HTTPS = new https.Agent({ keepAlive: true, maxSockets: 64, timeout: TIMEOUT_MS });
function getAgent(url) { return url.startsWith('https') ? AGENT_HTTPS : AGENT_HTTP; }
function fastFetch(url, opts) { return fetch(url, { ...opts, agent: getAgent(url), timeout: TIMEOUT_MS }); }

// ---- Config loading: supports old .env style AND new config.json ----
let config = { providers: {}, mappings: {}, default: '' };

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    } catch (e) {
      console.error('Warning: could not parse config.json:', e.message);
    }
  }

  // Merge .env legacy settings as a fallback provider
  const legacyKey = process.env.UPSTREAM_API_KEY;
  if (legacyKey && !config.providers['default-legacy']) {
    config.providers['default-legacy'] = {
      baseUrl: (process.env.UPSTREAM_BASE || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
      apiKey: legacyKey,
      authHeader: process.env.UPSTREAM_AUTH_HEADER || 'Authorization',
      authPrefix: process.env.UPSTREAM_AUTH_PREFIX || 'Bearer ',
    };
    if (!config.default) config.default = 'default-legacy:' + (process.env.TARGET_MODEL || 'deepseek-chat');

    // Build legacy mappings from env
    const big = process.env.BIG_MODEL || process.env.TARGET_MODEL || 'deepseek-chat';
    const small = process.env.SMALL_MODEL || big;
    const def = process.env.TARGET_MODEL || 'deepseek-chat';
    if (!config.mappings || Object.keys(config.mappings).length === 0) {
      config.mappings = {
        'claude-sonnet-4-20250514': `default-legacy:${big}`,
        'claude-opus-4-20250514': `default-legacy:${big}`,
        'claude-haiku-3-5-20241022': `default-legacy:${small}`,
      };
      config.default = `default-legacy:${def}`;
    }
  }

  // Ensure providers and mappings exist
  config.providers = config.providers || {};
  config.mappings = config.mappings || {};
}

loadConfig();

function resolveTarget(anthropicModel) {
  // 1. Exact match
  let entry = config.mappings[anthropicModel];
  // 2. Partial match (key is contained in requested model)
  if (!entry) {
    for (const [pattern, val] of Object.entries(config.mappings)) {
      if (pattern !== 'default' && anthropicModel.includes(pattern)) {
        entry = val; break;
      }
    }
  }
  if (!entry) entry = config.default;
  if (!entry) return null;

  // Parse "providerName:modelName"
  const colon = entry.indexOf(':');
  let providerName, modelName;
  if (colon > 0) {
    providerName = entry.slice(0, colon);
    modelName = entry.slice(colon + 1);
  } else {
    providerName = Object.keys(config.providers)[0] || 'default-legacy';
    modelName = entry;
  }

  const provider = config.providers[providerName] || config.providers[Object.keys(config.providers)[0]];
  if (!provider) return null;

  return {
    provider,
    providerName,
    model: modelName,
  };
}

function makeId() {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function parseToolInput(value, context) {
  if (value == null || value === '') return {};
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return {};

  try {
    return JSON.parse(value);
  } catch (e) {
    const strippedLeadingEmptyObjects = value.trim().replace(/^(?:\{\s*\})+(?=\s*[\[{])/, '');
    if (strippedLeadingEmptyObjects && strippedLeadingEmptyObjects !== value.trim()) {
      try {
        return JSON.parse(strippedLeadingEmptyObjects);
      } catch (_) {}
    }

    try {
      fs.appendFileSync(
        path.resolve(__dirname, 'tool-args-drop.log'),
        `[${new Date().toISOString()}] Could not parse tool arguments in ${context}: ${e.message}; raw=${value.slice(0, 1000)}\n`
      );
    } catch (_) {}
    return {};
  }
}

function extractToolArguments(tc, fallback = '{}') {
  return (
    tc?.function?.arguments ??
    tc?.function?.parameters ??
    tc?.function?.input ??
    tc?.arguments ??
    tc?.parameters ??
    tc?.input ??
    fallback
  );
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => {
    if (typeof block === 'string') return block;
    if (block?.type === 'text') return block.text || '';
    if (block?.text) return block.text;
    return '';
  }).filter(Boolean).join('\n');
}

function latestUserText(body) {
  for (const msg of [...(body?.messages || [])].reverse()) {
    if (msg.role === 'user') {
      const text = contentToText(msg.content);
      if (text.trim()) return text.trim();
    }
  }
  return '';
}

function toolSchemaFor(body, toolName) {
  const tool = (body?.tools || []).find(t => t.name === toolName);
  return tool?.input_schema || {};
}

function extractUrl(text) {
  const match = text.match(/https?:\/\/[^\s)\]"']+/i);
  return match ? match[0].replace(/[.,;:!?]+$/, '') : '';
}

function extractCommand(text) {
  const fenced = text.match(/```(?:\w+)?\s*([\s\S]*?)```/);
  if (fenced?.[1]?.trim()) return fenced[1].trim();
  const backtick = text.match(/`([^`]+)`/);
  if (backtick?.[1]?.trim()) return backtick[1].trim();
  const labeled = text.match(/(?:run|command|execute)(?:\s+exactly)?\s*:?\s*["']?(.+?)["']?$/i);
  return labeled?.[1]?.trim() || text.trim();
}

function extractFilePath(text) {
  const quoted = text.match(/["']([A-Za-z]:\\[^"']+|[^"']+\.[A-Za-z0-9]{1,8})["']/);
  if (quoted?.[1]) return quoted[1].trim();
  const winPath = text.match(/[A-Za-z]:\\[^\s"'<>|]+/);
  if (winPath?.[0]) return winPath[0].trim();
  const named = text.match(/(?:file(?:\s+named)?|save(?:\s+as)?|write(?:\s+to)?|create)\s+([^\s"'<>|]+\.[A-Za-z0-9]{1,8})/i);
  return named?.[1]?.trim() || '';
}

function slugFromText(text) {
  const cleaned = text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .split(/\s+/)
    .filter(word => !/^(create|make|write|file|document|about|using|with|the|a|an|to|for|please|word|pdf|docx)$/i.test(word))
    .slice(0, 5)
    .join('_')
    .toLowerCase();
  return cleaned || 'cowork_output';
}

function defaultFilePath(text, toolName) {
  const lower = `${toolName} ${text}`.toLowerCase();
  const stem = slugFromText(text);
  if (lower.includes('docx') || lower.includes('word')) return `${stem}.docx`;
  if (lower.includes('pdf')) return `${stem}.pdf`;
  if (lower.includes('json')) return `${stem}.json`;
  if (lower.includes('csv')) return `${stem}.csv`;
  if (lower.includes('html')) return `${stem}.html`;
  if (lower.includes('python')) return `${stem}.py`;
  return `${stem}.md`;
}

function inferSkill(text, schema) {
  const lower = text.toLowerCase();
  const enumValues = Array.isArray(schema?.enum) ? schema.enum : [];
  const byEnum = enumValues.find(v => lower.includes(String(v).toLowerCase()));
  if (byEnum) return byEnum;
  if (lower.includes('word') || lower.includes('docx')) return 'anthropic-skills:docx';
  if (lower.includes('pdf')) return 'anthropic-skills:pdf';
  if (lower.includes('powerpoint') || lower.includes('ppt')) return 'anthropic-skills:pptx';
  if (lower.includes('excel') || lower.includes('spreadsheet') || lower.includes('xlsx')) return 'anthropic-skills:xlsx';
  if (lower.includes('browser') || lower.includes('web page')) return 'anthropic-skills:browser';
  return enumValues[0] || '';
}

function isMissingValue(value) {
  return value === undefined || value === null || value === '';
}

function inferRequiredValue(field, fieldSchema, toolName, text) {
  const lowerField = field.toLowerCase();
  const lowerTool = toolName.toLowerCase();
  if (fieldSchema?.default !== undefined) return fieldSchema.default;
  if (Array.isArray(fieldSchema?.enum) && fieldSchema.enum.length) return fieldSchema.enum[0];
  if (lowerField.includes('url') || lowerField === 'href' || lowerField === 'uri') return extractUrl(text);
  if (lowerField === 'query' || lowerField === 'q') {
    const search = text.match(/(?:search(?:\s+for)?|query)\s*:?\s*(.+)$/i);
    return (search?.[1] || text).trim();
  }
  if (lowerField === 'command' || lowerTool.includes('bash')) return extractCommand(text);
  if (lowerField === 'file_path' || lowerField === 'filepath' || lowerField === 'path') return extractFilePath(text) || defaultFilePath(text, toolName);
  if (lowerField === 'skill') return inferSkill(text, fieldSchema);
  if (lowerField === 'content' || lowerField === 'text' || lowerField === 'input') return text.trim();
  if (fieldSchema?.type === 'array') return [];
  if (fieldSchema?.type === 'object') return {};
  if (fieldSchema?.type === 'boolean') return false;
  if (fieldSchema?.type === 'integer' || fieldSchema?.type === 'number') return 0;
  if (fieldSchema?.type === 'string') return extractUrl(text) || text.trim();
  return undefined;
}

function repairToolInput(input, toolName, body) {
  const schema = toolSchemaFor(body, toolName);
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (!required.length) return input;

  const repaired = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {};
  const text = latestUserText(body);
  const filled = {};

  for (const field of required) {
    const lowerField = field.toLowerCase();
    if (lowerField === 'skill') {
      const inferredSkill = inferSkill(text, schema.properties?.[field]);
      if (inferredSkill && (isMissingValue(repaired[field]) || !String(repaired[field]).startsWith('anthropic-skills:'))) {
        repaired[field] = inferredSkill;
        filled[field] = inferredSkill;
      }
      continue;
    }
    if (!isMissingValue(repaired[field])) continue;
    const value = inferRequiredValue(field, schema.properties?.[field], toolName, text);
    if (!isMissingValue(value)) {
      repaired[field] = value;
      filled[field] = value;
    }
  }

  if (Object.keys(filled).length) {
    try {
      fs.appendFileSync(
        path.resolve(__dirname, 'tool-args-backfill.log'),
        `[${new Date().toISOString()}] ${toolName} filled ${JSON.stringify(filled)} from latest user text\n`
      );
    } catch (_) {}
  }

  return repaired;
}

function logToolInput(toolName, input, context) {
  try {
    fs.appendFileSync(
      path.resolve(__dirname, 'tool-args-backfill.log'),
      `[${new Date().toISOString()}] ${context} ${toolName} input keys ${JSON.stringify(Object.keys(input || {}))}\n`
    );
  } catch (_) {}
}

function synthesizeToolUse(body) {
  const toolName = body?.tool_choice?.type === 'tool'
    ? body.tool_choice.name
    : body?.tools?.[0]?.name;
  if (!toolName) return null;
  const input = repairToolInput({}, toolName, body);
  return {
    id: makeId(),
    type: 'message',
    role: 'assistant',
    content: [{ type: 'tool_use', id: `call_${Date.now().toString(36)}`, name: toolName, input }],
    model: SPOOF_MODEL,
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

function shouldSynthesizeToolUse(status, text, body) {
  if (!body?.tools?.length) return false;
  if (status < 400 || status >= 500) return false;
  return /tool call|tool_choice|function|arguments|valid JSON/i.test(text || '');
}

function anthropicToOpenAI(body) {
  const messages = [];
  const system = typeof body.system === 'string' ? body.system : body.system?.text || '';
  const toolBridgeInstruction = body.tools?.length
    ? 'Tool-calling requirement: when calling a tool, include a JSON input object with every required parameter from the tool schema. Never emit an empty input object for a tool that has required parameters. Infer obvious values from the user request, including url, query, command, file_path, content, and skill.'
    : '';

  for (const m of body.messages || []) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        messages.push({ role: 'user', content: m.content });
      } else if (Array.isArray(m.content)) {
        const parts = [];
        for (const block of m.content) {
          if (block.type === 'text') parts.push({ type: 'text', text: block.text });
          else if (block.type === 'image' && block.source) {
            parts.push({ type: 'image_url', image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } });
          } else if (block.type === 'tool_result') {
            const txt = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
            messages.push({ role: 'tool', content: txt, tool_call_id: block.tool_use_id || '' });
          }
        }
        if (parts.length) messages.push({ role: 'user', content: parts });
      }
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: '' };
      const tcs = [];
      if (typeof m.content === 'string') {
        msg.content = m.content;
      } else if (Array.isArray(m.content)) {
        const texts = [];
        for (const block of m.content) {
          if (block.type === 'text') texts.push(block.text);
          else if (block.type === 'tool_use') {
            tcs.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input || {}) } });
          } else if (block.type === 'thinking') {
            texts.push(block.thinking || '');
          }
        }
        msg.content = texts.join('');
      }
      if (tcs.length) msg.tool_calls = tcs;
      messages.push(msg);
    } else if (m.role === 'tool_result') {
      const txt = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      messages.push({ role: 'tool', content: txt, tool_call_id: m.tool_use_id || '' });
    }
  }

  if (system || toolBridgeInstruction) messages.unshift({ role: 'system', content: [system, toolBridgeInstruction].filter(Boolean).join('\n\n') });

  const result = {
    model: '', // filled by caller
    messages,
    max_tokens: body.max_tokens || 8192,
    stream: !!body.stream,
    temperature: body.temperature ?? 0.7,
  };
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.stop_sequences?.length) result.stop = body.stop_sequences;

  if (body.tools?.length) {
    result.tools = body.tools.map(t => {
      const required = Array.isArray(t.input_schema?.required) ? t.input_schema.required : [];
      const requiredText = required.length ? `\n\nRequired parameters: ${required.join(', ')}. Always populate these from the user's request; do not call this tool with {}.` : '';
      return { type: 'function', function: { name: t.name, description: `${t.description || ''}${requiredText}`, parameters: t.input_schema || {} } };
    });
    if (body.tool_choice) {
      const tc = body.tool_choice;
      if (tc.type === 'any') result.tool_choice = 'required';
      else if (tc.type === 'tool') result.tool_choice = { type: 'function', function: { name: tc.name } };
      else result.tool_choice = 'auto';
    } else result.tool_choice = 'auto';
  }

  return result;
}

function buildResponse(openaiData, anthropicBody) {
  const choice = openaiData.choices?.[0]?.message || openaiData.choices?.[0]?.delta || {};
  const finish = openaiData.choices?.[0]?.finish_reason;
  const content = [];
  const text = choice.content || '';
  if (text) content.push({ type: 'text', text });
  if (choice.tool_calls) {
    for (const tc of choice.tool_calls) {
      if (tc.type === 'function') {
        const toolName = tc.function.name;
        const input = repairToolInput(
          parseToolInput(extractToolArguments(tc), 'non-stream response'),
          toolName,
          anthropicBody
        );
        logToolInput(toolName, input, 'non-stream');
        content.push({
          type: 'tool_use', id: tc.id, name: toolName,
          input,
        });
      }
    }
  }
  if (!choice.tool_calls?.length && anthropicBody?.tool_choice?.type === 'tool') return synthesizeToolUse(anthropicBody);
  const stopMap = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use' };
  const hasTools = choice.tool_calls?.length > 0;
  return {
    id: makeId(), type: 'message', role: 'assistant', content, model: SPOOF_MODEL,
    stop_reason: hasTools ? 'tool_use' : (stopMap[finish] || 'end_turn'), stop_sequence: null,
    usage: {
      input_tokens: openaiData.usage?.prompt_tokens || Math.ceil((openaiData.usage?.total_tokens || 0) * 0.75),
      output_tokens: openaiData.usage?.completion_tokens || Math.ceil((openaiData.usage?.total_tokens || 0) * 0.25),
    },
  };
}

function auth(req) {
  if (!PROXY_AUTH_TOKEN) return true;
  const key = req.headers['x-api-key'] || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  return key === PROXY_AUTH_TOKEN;
}

// ---- Stats ----
const stats = { started: Date.now(), requests: 0, byModel: {}, byProvider: {}, errors: 0 };
function trackStats(model, providerName, isError) {
  stats.requests++;
  stats.byModel[model] = (stats.byModel[model] || 0) + 1;
  stats.byProvider[providerName] = (stats.byProvider[providerName] || 0) + 1;
  if (isError) stats.errors++;
}

fs.writeFileSync(PID_FILE, String(process.pid));

// ---- App ----
const app = express();
app.use(express.json({ limit: '100mb' }));

// ---- Request handler (routes to correct provider) ----
app.post('/v1/messages', (req, res) => {
  if (!auth(req)) return res.status(401).json({ error: { type: 'authentication_error', message: 'Invalid API key' } });
  if (!req.body?.messages?.length) return res.status(400).json({ error: { type: 'invalid_request', message: 'messages required' } });

  const resolved = resolveTarget(req.body.model);
  if (!resolved) return res.status(400).json({ error: { type: 'invalid_request', message: `No provider/model configured for '${req.body.model}'. Check config.json mappings.` } });

  const { provider, providerName, model: upstreamModel } = resolved;
  const oaiReq = anthropicToOpenAI(req.body);
  oaiReq.model = upstreamModel;

  const origJson = res.json.bind(res);
  const origEnd = res.end.bind(res);
  let tracked = false;
  const track = () => { if (!tracked) { tracked = true; trackStats(req.body.model, providerName, res.statusCode >= 400); } };
  res.json = function (d) { track(); return origJson(d); };
  res.end = function (...args) { track(); return origEnd(...args); };

  if (req.body.stream) {
    handleStream(req, res, oaiReq, provider);
  } else {
    handleNonStream(res, oaiReq, provider, req.body);
  }
});

async function upstreamFetch(provider, oaiReq) {
  const headers = {
    'Content-Type': 'application/json',
    [provider.authHeader || 'Authorization']: `${provider.authPrefix || 'Bearer '}${provider.apiKey}`,
  };
  return fastFetch(`${provider.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(oaiReq) });
}

function handleNonStream(res, oaiReq, provider, anthropicBody) {
  upstreamFetch(provider, oaiReq).then(async r => {
    if (!r.ok) {
      const t = await r.text();
      if (shouldSynthesizeToolUse(r.status, t, anthropicBody)) return res.json(synthesizeToolUse(anthropicBody));
      return res.status(r.status).json({ error: { type: 'upstream_error', message: `[${provider.baseUrl}] ${t}` } });
    }
    const data = await r.json();
    res.json(buildResponse(data, anthropicBody));
  }).catch(e => res.status(502).json({ error: { type: 'proxy_error', message: e.message } }));
}

async function handleStream(req, res, oaiReq, provider) {
  oaiReq.stream = true;
  const oaiBody = JSON.stringify(oaiReq);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const ss = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const msgId = makeId();
  const emitToolUseBlock = (index, toolUse) => {
    const input = toolUse.input && typeof toolUse.input === 'object' && !Array.isArray(toolUse.input)
      ? toolUse.input
      : {};
    ss('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: toolUse.id || `call_${index}`, name: toolUse.name, input: {} },
    });
    ss('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    });
    ss('content_block_stop', { type: 'content_block_stop', index });
  };

  try {
    const upstream = await upstreamFetch(provider, { ...oaiReq, stream: true });

    if (!upstream.ok) {
      const t = await upstream.text();
      if (shouldSynthesizeToolUse(upstream.status, t, req.body)) {
        const synthetic = synthesizeToolUse(req.body);
        ss('content_block_stop', { type: 'content_block_stop', index: 0 });
        emitToolUseBlock(1, synthetic.content[0]);
        ss('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 0 } });
        ss('message_stop', { type: 'message_stop' });
        return res.end();
      }
      ss('error', { error: { type: 'upstream_error', message: `[${provider.baseUrl}] ${t}` } });
      return res.end();
    }

    ss('message_start', {
      type: 'message_start',
      message: { id: msgId, type: 'message', role: 'assistant', content: [], model: SPOOF_MODEL, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    });
    ss('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });

    let textBuffer = '', toolCalls = {}, hasTools = false, finished = false, buf = '';
    const decoder = new TextDecoder();

    upstream.body.on('data', chunk => {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const raw = trimmed.slice(6).trim();
        if (raw === '[DONE]') continue;
        let parsed;
        try { parsed = JSON.parse(raw); } catch { continue; }
        const delta = parsed.choices?.[0]?.delta || {};
        const finish = parsed.choices?.[0]?.finish_reason;

        if (delta.content) {
          textBuffer += delta.content;
          ss('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta.content } });
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCalls[idx]) toolCalls[idx] = { id: '', name: '', arguments: '' };
            if (tc.id) toolCalls[idx].id = tc.id;
            if (tc.function?.name) toolCalls[idx].name = tc.function.name;
            const argDelta = extractToolArguments(tc, '');
            if (typeof argDelta === 'string') toolCalls[idx].arguments += argDelta;
            else if (argDelta && typeof argDelta === 'object') toolCalls[idx].arguments = argDelta;
            hasTools = true;
          }
        }
        if (delta.reasoning_content) {
          ss('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: delta.reasoning_content } });
        }

        if (finish && !finished) {
          finished = true;
          ss('content_block_stop', { type: 'content_block_stop', index: 0 });
          let toolIdx = 1;
          for (const tc of Object.values(toolCalls)) {
            const input = repairToolInput(parseToolInput(tc.arguments, 'stream response'), tc.name, req.body);
            logToolInput(tc.name, input, 'stream');
            emitToolUseBlock(toolIdx, { type: 'tool_use', id: tc.id || `call_${toolIdx}`, name: tc.name, input });
            toolIdx++;
          }
          const stopMap = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use' };
          ss('message_delta', { type: 'message_delta', delta: { stop_reason: hasTools ? 'tool_use' : (stopMap[finish] || 'end_turn'), stop_sequence: null }, usage: { output_tokens: parsed.usage?.completion_tokens || textBuffer.length } });
          ss('message_stop', { type: 'message_stop' });
        }
      }
    });

    upstream.body.on('end', () => {
      if (!finished) {
        ss('content_block_stop', { type: 'content_block_stop', index: 0 });
        if (req.body?.tool_choice?.type === 'tool') {
          const synthetic = synthesizeToolUse(req.body);
          ss('content_block_start', { type: 'content_block_start', index: 1, content_block: synthetic.content[0] });
          ss('content_block_stop', { type: 'content_block_stop', index: 1 });
          ss('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: textBuffer.length } });
        } else {
          ss('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: textBuffer.length } });
        }
        ss('message_stop', { type: 'message_stop' });
      }
      res.end();
    });

    upstream.body.on('error', () => res.end());
  } catch (e) {
    ss('error', { error: { type: 'proxy_error', message: e.message } });
    res.end();
  }
}

// ---- Other endpoints ----
app.post('/v1/messages/count_tokens', (req, res) => {
  if (!auth(req)) return res.status(401).json({ error: { type: 'authentication_error', message: 'Invalid API key' } });
  res.json({ input_tokens: Math.ceil(JSON.stringify(req.body).length / 3.5), output_tokens: 0 });
});

app.get('/v1/models', (req, res) => {
  const data = [];
  const seen = new Set();
  for (const spoof of Object.keys(config.mappings)) {
    if (spoof === 'default') continue;
    data.push({ id: spoof, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'anthropic' });
    seen.add(spoof);
  }
  if (!seen.has(SPOOF_MODEL)) data.unshift({ id: SPOOF_MODEL, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'anthropic' });
  res.json({ data });
});

app.get('/health', (req, res) => res.json({
  ok: true, spoof: SPOOF_MODEL, upstream: Object.values(config.providers).map(p => p.baseUrl),
  providers: Object.keys(config.providers).length, mappings: Object.keys(config.mappings).length,
}));

// ---- Admin API ----
app.get('/admin/stats', (req, res) => {
  const modelEntries = Object.entries(config.mappings).filter(([k]) => k !== 'default');
  res.json({
    ...stats, pid: process.pid, uptime: Math.floor((Date.now() - stats.started) / 1000),
    providers: Object.keys(config.providers),
    modelMappings: modelEntries.map(([k, v]) => ({ spoof: k, target: v })),
    defaultTarget: config.default || '',
  });
});

app.post('/admin/reload', (req, res) => {
  try { loadConfig(); res.json({ ok: true, providers: Object.keys(config.providers).length, mappings: Object.keys(config.mappings).length }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/admin/providers', (req, res) => {
  res.json({ data: Object.entries(config.providers).map(([k, v]) => ({ name: k, baseUrl: v.baseUrl, apiKey: (v.apiKey || '').slice(0, 8) + '...' })) });
});

app.put('/admin/providers', (req, res) => {
  const { name, baseUrl, apiKey } = req.body || {};
  if (!name || !baseUrl || !apiKey) return res.status(400).json({ error: 'name, baseUrl, apiKey required' });
  config.providers[name] = { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, authHeader: req.body.authHeader || 'Authorization', authPrefix: req.body.authPrefix || 'Bearer ' };
  saveConfig();
  res.json({ ok: true });
});

app.delete('/admin/providers', (req, res) => {
  const { name } = req.body || {};
  if (!name || !config.providers[name]) return res.status(400).json({ error: 'valid name required' });
  delete config.providers[name];
  // Remove mappings using this provider
  for (const [k, v] of Object.entries(config.mappings)) {
    if (v.startsWith(name + ':')) delete config.mappings[k];
  }
  saveConfig();
  res.json({ ok: true });
});

app.post('/admin/mappings', (req, res) => {
  const { spoof, target } = req.body || {};
  if (!spoof || !target) return res.status(400).json({ error: 'spoof and target (provider:model) required' });
  const colon = target.indexOf(':');
  if (colon <= 0 || !config.providers[target.slice(0, colon)]) return res.status(400).json({ error: `Provider '${target.slice(0, colon)}' not found. Add it first.` });
  config.mappings[spoof] = target;
  saveConfig();
  res.json({ ok: true });
});

app.delete('/admin/mappings', (req, res) => {
  const { spoof } = req.body || {};
  if (!spoof || !config.mappings[spoof]) return res.status(400).json({ error: 'valid spoof name required' });
  delete config.mappings[spoof];
  saveConfig();
  res.json({ ok: true });
});

function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch (e) { console.error('Could not save config:', e.message); }
}

// ---- Start ----
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Claude Spoof Proxy`);
  console.log(`  ${'='.repeat(40)}`);
  console.log(`  Listen:   http://0.0.0.0:${PORT}`);
  console.log(`  Providers: ${Object.keys(config.providers).join(', ') || '(none)'}`);
  console.log(`  Mappings:  ${Object.keys(config.mappings).length}`);
  for (const [spoof, target] of Object.entries(config.mappings)) {
    if (spoof !== 'default') console.log(`    ${spoof.padEnd(35)} -> ${target}`);
  }
  console.log(`  ${'='.repeat(40)}\n`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ✗ Port ${PORT} is already in use.`);
    console.error(`  Use: csp restart   or   csp start --force\n`);
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});
