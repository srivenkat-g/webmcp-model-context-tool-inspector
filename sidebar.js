/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI } from './js-genai.js';
import { initGeminiLive, updateLiveTools } from './gemini-live.js';
import { getAllFrameOrigins } from './utils.js';

const statusDiv = document.getElementById('status');
const tbody = document.getElementById('tableBody');
const thead = document.getElementById('tableHeaderRow');
const copyToClipboard = document.getElementById('copyToClipboard');
const copyAsScriptToolConfig = document.getElementById('copyAsScriptToolConfig');
const copyAsJSON = document.getElementById('copyAsJSON');
const toolNames = document.getElementById('toolNames');
const inputArgsText = document.getElementById('inputArgsText');
const executeBtn = document.getElementById('executeBtn');
const toolResults = document.getElementById('toolResults');
const userPromptText = document.getElementById('userPromptText');
const promptBtn = document.getElementById('promptBtn');
const traceBtn = document.getElementById('traceBtn');
const resetBtn = document.getElementById('resetBtn');
const apiKeyBtn = document.getElementById('apiKeyBtn');
const promptResults = document.getElementById('promptResults');
const auditRecipeBtn = document.getElementById('auditRecipeBtn');
const modelSelect = document.getElementById('modelSelect');
const advancedSection = document.getElementById('advancedSection');
const micBtn = document.getElementById('micBtn');
const suggestUserPromptCheckbox = document.getElementById('suggestUserPromptCheckbox');

// Request list of tools from content script living in top-level frame.
async function requestToolsFromActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      statusDiv.textContent = 'Navigate to a webpage (e.g. RSC) to inspect WebMCP tools.';
      statusDiv.hidden = false;
      copyToClipboard.hidden = true;
      return;
    }
    const fromOrigins = await getAllFrameOrigins(tab.id);
    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'LIST_TOOLS', fromOrigins }, { frameId: 0 });
    } catch {
      // Content script may not be injected yet; inject dynamically:
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js'],
        });
        await chrome.tabs.sendMessage(tab.id, { action: 'LIST_TOOLS', fromOrigins }, { frameId: 0 });
      } catch {}
    }
  } catch (error) {
    statusDiv.textContent = 'Please refresh the active web tab to connect the inspector.';
    statusDiv.hidden = false;
    copyToClipboard.hidden = true;
  }
}

requestToolsFromActiveTab();

chrome.tabs.onActivated.addListener(() => requestToolsFromActiveTab());
chrome.tabs.onUpdated.addListener((_, changeInfo) => {
  if (changeInfo.status === 'complete') requestToolsFromActiveTab();
});

let currentTools = [];

let userPromptPendingId = 0;
let lastSuggestedUserPrompt = '';

// Listen for the results coming back from content.js
chrome.runtime.onMessage.addListener(async ({ message, tools, url, type, tabId }, sender) => {
  // Internal signals (e.g. contentScriptReady) are handled elsewhere.
  if (type) return;
  if (sender.frameId && sender.frameId !== 0) return;
  if (!message && !tools) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (sender.tab && sender.tab.id !== tab.id) return;
  // Ignore errors about other tabs, e.g. the mic permission popup window.
  if (tabId && tabId !== tab.id) return;

  tbody.innerHTML = '';
  thead.innerHTML = '';
  toolNames.innerHTML = '';

  statusDiv.textContent = message;
  statusDiv.hidden = !message;

  const haveNewTools = JSON.stringify(currentTools) !== JSON.stringify(tools);

  currentTools = tools || [];
  if (haveNewTools) updateLiveTools();

  if (!tools || tools.length === 0) {
    const row = document.createElement('tr');
    row.innerHTML = `<td colspan="100%"><i>No tools registered yet in ${url || tab.url}</i></td>`;
    tbody.appendChild(row);
    inputArgsText.value = '';
    inputArgsText.disabled = true;
    toolNames.disabled = true;
    executeBtn.disabled = true;
    copyToClipboard.hidden = true;
    return;
  }

  inputArgsText.disabled = false;
  toolNames.disabled = false;
  executeBtn.disabled = false;
  copyToClipboard.hidden = false;

  const KEYS = ['description', 'inputSchema', 'annotations', 'name'];
  const keys = KEYS.filter((key) => tools.some((tool) => key in tool));
  keys.forEach((key) => {
    const th = document.createElement('th');
    th.textContent = key;
    thead.appendChild(th);
  });

  tools.forEach((item) => {
    const row = document.createElement('tr');
    keys.forEach((key) => {
      const td = document.createElement('td');
      const pre = document.createElement('pre');
      try {
        pre.textContent = JSON.stringify(JSON.parse(item[key]), '', '  ');
        td.appendChild(pre);
      } catch (error) {
        td.textContent = item[key];
      }
      row.appendChild(td);
    });
    tbody.appendChild(row);

    const option = document.createElement('option');
    option.textContent = `"${item.name}"${item.frameId !== 0 ? ` (${item.frameId})` : ''}`;
    option.value = item.name;
    option.dataset.inputSchema = item.inputSchema || '{}';
    option.dataset.frameId = item.frameId;
    toolNames.appendChild(option);
  });
  updateDefaultValueForInputArgs();

  if (haveNewTools) suggestUserPrompt();
});

tbody.ondblclick = () => {
  tbody.classList.toggle('prettify');
};

copyAsScriptToolConfig.onclick = async () => {
  const text = (currentTools || [])
    .map((tool) => {
      return `\
script_tools {
  name: ${JSON.stringify(tool.name)}
  description: ${JSON.stringify(tool.description || '')}
  input_schema: ${JSON.stringify(tool.inputSchema || { type: 'object', properties: {} })}
}`;
    })
    .join('\r\n');
  await navigator.clipboard.writeText(text);
};

copyAsJSON.onclick = async () => {
  const tools = (currentTools || []).map((tool) => {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
        ? JSON.parse(tool.inputSchema)
        : { type: 'object', properties: {} },
    };
  });
  await navigator.clipboard.writeText(JSON.stringify(tools, '', '  '));
};

// Interact with the page

let genAI, chat, basecampMessages;

const BASECAMP_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'claude-opus-5-5',
  'claude-fable-5-1',
  'claude-opus-5',
  'deepseek-v4.1-flash',
  'glm-5.3-flash',
  'glm-5.3',
  'glm-5.2',
  'qwen-3.8-max',
];

function updateActiveModelDisplay() {
  if (modelSelect) {
    const isBasecamp = (localStorage.provider || 'basecamp') === 'basecamp';
    if (isBasecamp) {
      modelSelect.style.display = 'inline-block';
      modelSelect.value = localStorage.basecampModel || 'gemini-3.8-flash';
    } else {
      modelSelect.style.display = 'none';
    }
  }
}

async function initGenAI() {
  let env;
  try {
    // Try load .env.json if present.
    env = (await import('./.env.json', { with: { type: 'json' } })).default;
  } catch {}

  if (env?.basecampApiKey) localStorage.basecampApiKey ??= env.basecampApiKey;
  if (env?.apiKey) localStorage.apiKey ??= env.apiKey;
  if (env?.provider) localStorage.provider ??= env.provider;
  if (env?.basecampModel) localStorage.basecampModel ??= env.basecampModel;

  localStorage.provider ??= (localStorage.basecampApiKey || !localStorage.apiKey) ? 'basecamp' : 'gemini';
  if (!BASECAMP_MODELS.includes(localStorage.basecampModel)) {
    localStorage.basecampModel = 'gemini-3.8-flash';
  }
  localStorage.basecampUrl ??= 'https://basecamp.stark.rubrik.com/v1';

  if (localStorage.model === 'gemini-2.5-flash') {
    localStorage.model = 'gemini-3-flash-preview';
  }
  if (localStorage.model === 'gemini-3.1-flash-lite-preview') {
    localStorage.model = 'gemini-3.1-flash-lite';
  }
  localStorage.model ??= env?.model || 'gemini-3.6-flash';

  const isBasecamp = localStorage.provider === 'basecamp';
  const hasKey = isBasecamp
    ? Boolean(localStorage.basecampApiKey || localStorage.apiKey)
    : Boolean(localStorage.apiKey);

  if (!isBasecamp && localStorage.apiKey) {
    genAI = new GoogleGenAI({ apiKey: localStorage.apiKey });
  } else {
    genAI = undefined;
  }

  promptBtn.disabled = !hasKey;
  if (auditRecipeBtn) auditRecipeBtn.disabled = !hasKey;
  resetBtn.disabled = !hasKey;

  apiKeyBtn.textContent = hasKey
    ? (isBasecamp ? 'Update Basecamp Key' : 'Update Gemini Key')
    : (isBasecamp ? 'Set Basecamp API Key' : 'Set Gemini API Key');

  suggestUserPromptCheckbox.checked = localStorage.suggestUserPrompt !== 'false';
  updateActiveModelDisplay();
}
await initGenAI();

document.querySelectorAll('input[name="provider"]').forEach((radio) => {
  radio.checked = radio.value === (localStorage.provider || 'basecamp');
  radio.onclick = async () => {
    localStorage.provider = radio.value;
    chat = undefined;
    basecampMessages = undefined;
    await initGenAI();
    updateActiveModelDisplay();
    advancedSection.hidePopover();
  };
});

document.querySelectorAll('input[name="basecampModel"]').forEach((radio) => {
  radio.checked = radio.value === (localStorage.basecampModel || 'gemini-3.8-flash');
  radio.onclick = () => {
    localStorage.basecampModel = radio.value;
    basecampMessages = undefined;
    updateActiveModelDisplay();
    advancedSection.hidePopover();
  };
});

if (modelSelect) {
  modelSelect.onchange = () => {
    localStorage.basecampModel = modelSelect.value;
    basecampMessages = undefined;
    document.querySelectorAll('input[name="basecampModel"]').forEach((radio) => {
      radio.checked = radio.value === modelSelect.value;
    });
  };
}

document.querySelectorAll('input[name="model"]').forEach((radio) => {
  radio.checked = radio.value === localStorage.model;
  radio.onclick = () => {
    localStorage.model = radio.value;
    chat = undefined;
    updateActiveModelDisplay();
    advancedSection.hidePopover();
  };
});

suggestUserPromptCheckbox.onchange = () => {
  localStorage.suggestUserPrompt = suggestUserPromptCheckbox.checked;
  if (localStorage.suggestUserPrompt) suggestUserPrompt();
  advancedSection.hidePopover();
};

async function suggestUserPrompt() {
  if (localStorage.suggestUserPrompt === 'false') return;
  if (currentTools.length == 0 || userPromptText.value !== lastSuggestedUserPrompt) return;

  const isBasecamp = (localStorage.provider || 'basecamp') === 'basecamp';
  const key = isBasecamp ? (localStorage.basecampApiKey || localStorage.apiKey) : localStorage.apiKey;
  if (!key) return;

  const userPromptId = ++userPromptPendingId;

  if (isBasecamp) {
    const model = localStorage.basecampModel || 'gemini-3.8-flash';
    const baseUrl = localStorage.basecampUrl || 'https://basecamp.stark.rubrik.com/v1';
    try {
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content: `Today's date is: ${getFormattedDate()}. Generate one natural user query for the tools below. Output query text only.`,
            },
            {
              role: 'user',
              content: `Tools: ${JSON.stringify(currentTools)}`,
            },
          ],
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        const text = data.choices?.[0]?.message?.content?.trim();
        if (text && userPromptId === userPromptPendingId && userPromptText.value === lastSuggestedUserPrompt) {
          lastSuggestedUserPrompt = text;
          userPromptText.value = '';
          for (const chunk of text) {
            await new Promise((r) => requestAnimationFrame(r));
            userPromptText.value += chunk;
          }
        }
      }
    } catch {}
    return;
  }

  if (!genAI) return;
  const response = await genAI.models.generateContent({
    model: localStorage.model,
    contents: [
      '**Context:**',
      `Today's date is: ${getFormattedDate()}`,
      '**Tool Rules:**',
      '1. **Bank Transaction Filter:** Use **PAST** dates only (e.g., "last month," "December 15th," "yesterday").',
      '2. **Flight Search:** Use **FUTURE** dates only (e.g., "next week," "February 15th").',
      '3. **Accommodation Search:** Use **FUTURE** dates only (e.g., "next weekend," "March 15th").',
      '**Task:**',
      'Generate one natural user query for a range of tools below, ideally chaining them together.',
      'Ensure the date makes sense relative to today.',
      'Output the query text only.',
      '**Tools:**',
      JSON.stringify(currentTools),
    ],
  });
  if (userPromptId !== userPromptPendingId || userPromptText.value !== lastSuggestedUserPrompt)
    return;
  lastSuggestedUserPrompt = response.text;
  userPromptText.value = '';
  for (const chunk of response.text) {
    await new Promise((r) => requestAnimationFrame(r));
    userPromptText.value += chunk;
  }
}

userPromptText.onkeydown = (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    promptBtn.click();
  }
};

promptBtn.onclick = async () => {
  try {
    const isBasecamp = (localStorage.provider || 'basecamp') === 'basecamp';
    if (isBasecamp) {
      await promptBasecampAI();
    } else {
      await promptAI();
    }
  } catch (error) {
    trace.push({ error });
    logPrompt(`⚠️ Error: "${error.message || error}"`);
  }
};

let trace = [];

async function promptBasecampAI() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const model = localStorage.basecampModel || 'gemini-3.8-flash';
  const apiKey = localStorage.basecampApiKey || localStorage.apiKey;
  const baseUrl = localStorage.basecampUrl || 'https://basecamp.stark.rubrik.com/v1';

  const message = userPromptText.value.trim();
  if (!message) return;
  userPromptText.value = '';
  lastSuggestedUserPrompt = '';
  logPrompt(`User prompt: "${message}"`);

  basecampMessages ??= [
    {
      role: 'system',
      content: getSystemInstructionText(),
    },
  ];

  basecampMessages.push({ role: 'user', content: message });

  const formattedTools = (currentTools || []).map((tool) => ({
    type: 'function',
    function: {
      name: `_${tool.frameId}_${tool.name}`,
      description: tool.description || '',
      parameters: tool.inputSchema
        ? (typeof tool.inputSchema === 'string' ? JSON.parse(tool.inputSchema) : tool.inputSchema)
        : { type: 'object', properties: {} },
    },
  }));

  let finalResponseGiven = false;

  while (!finalResponseGiven) {
    const requestPayload = {
      model,
      messages: basecampMessages,
    };
    if (formattedTools.length > 0) {
      requestPayload.tools = formattedTools;
    }
    trace.push({ basecampRequest: requestPayload });

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestPayload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Basecamp returned status ${response.status}: ${errText}`);
    }

    const data = await response.json();
    trace.push({ basecampResponse: data });

    const choice = data.choices?.[0];
    const assistantMessage = choice?.message;

    if (!assistantMessage) {
      logPrompt(`⚠️ Basecamp response has no message: ${JSON.stringify(data)}`);
      break;
    }

    basecampMessages.push(assistantMessage);

    const toolCalls = assistantMessage.tool_calls || [];
    if (toolCalls.length === 0) {
      if (assistantMessage.content) {
        renderAiResult(assistantMessage.content.trim());
      }
      finalResponseGiven = true;
    } else {
      for (const toolCall of toolCalls) {
        const toolName = toolCall.function.name;
        let [frameId, name] = toolName.split(/_(.*)/s)[1].split(/_(.*)/s);
        frameId = parseInt(frameId);
        const inputArgs = toolCall.function.arguments;
        logPrompt(`AI calling tool "${name}" with ${inputArgs}`);
        try {
          const result = await executeTool(tab.id, name, inputArgs, frameId);
          logPrompt(`Tool "${name}" result: ${result}`);
          basecampMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: typeof result === 'string' ? result : JSON.stringify(result),
          });
        } catch (e) {
          logPrompt(`⚠️ Error executing tool "${name}": ${e.message}`);
          basecampMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify({ error: e.message }),
          });
        }
      }
    }
  }
}

async function promptAI() {
  const message = userPromptText.value.trim();
  if (!message) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  chat ??= genAI.chats.create({ model: localStorage.model });

  userPromptText.value = '';
  lastSuggestedUserPrompt = '';
  logPrompt(`User prompt: "${message}"`);
  const sendMessageParams = { message, config: getConfig() };
  trace.push({ userPrompt: sendMessageParams });
  let currentResult = await chat.sendMessage(sendMessageParams);
  let finalResponseGiven = false;

  while (!finalResponseGiven) {
    const response = currentResult;
    trace.push({ response });
    const functionCalls = response.functionCalls || [];

    if (functionCalls.length === 0) {
      if (!response.text) {
        logPrompt(`⚠️ AI response has no text: ${JSON.stringify(response.candidates)}\n`);
      } else {
        renderAiResult(response.text?.trim());
      }
      finalResponseGiven = true;
    } else {
      const toolResponses = [];
      for (const { name: toolName, args } of functionCalls) {
        let [frameId, name] = toolName.split(/_(.*)/s)[1].split(/_(.*)/s);
        frameId = parseInt(frameId);
        const inputArgs = JSON.stringify(args);
        logPrompt(`AI calling tool "${name}" with ${inputArgs}`);
        try {
          const result = await executeTool(tab.id, name, inputArgs, frameId);
          toolResponses.push({ functionResponse: { name: toolName, response: { result } } });
          logPrompt(`Tool "${name}" result: ${result}`);
        } catch (e) {
          logPrompt(`⚠️ Error executing tool "${name}": ${e.message}`);
          toolResponses.push({
            functionResponse: { name: toolName, response: { error: e.message } },
          });
        }
      }

      const sendMessageParams = { message: toolResponses, config: getConfig() };
      trace.push({ userPrompt: sendMessageParams });
      currentResult = await chat.sendMessage(sendMessageParams);
    }
  }
}

resetBtn.onclick = () => {
  chat = undefined;
  basecampMessages = undefined;
  trace = [];
  userPromptText.value = '';
  lastSuggestedUserPrompt = '';
  promptResults.innerHTML = '';
  suggestUserPrompt();
};

if (auditRecipeBtn) {
  auditRecipeBtn.onclick = () => {
    userPromptText.value =
      'Audit our Salesforce protection on this page: check active vs paused alerts, identify unmonitored objects, and generate a standalone Python script using standard libraries to run this audit monthly.';
    promptBtn.click();
  };
}

apiKeyBtn.onclick = async () => {
  const isBasecamp = (localStorage.provider || 'basecamp') === 'basecamp';
  if (isBasecamp) {
    const key = prompt(
      'Enter Rubrik Basecamp (LiteLLM) API Key:\n(Generate at https://basecamp-self-serve.stark.rubrik.com/)',
      localStorage.basecampApiKey || localStorage.apiKey || '',
    );
    if (key == null) return;
    localStorage.basecampApiKey = key.trim();
  } else {
    const apiKey = prompt('Enter Google Gemini API key', localStorage.apiKey);
    if (apiKey == null) return;
    localStorage.apiKey = apiKey.trim();
  }
  await initGenAI();
  suggestUserPrompt();
};

traceBtn.onclick = async () => {
  const text = JSON.stringify(trace, '', ' ');
  await navigator.clipboard.writeText(text);
};

executeBtn.onclick = async () => {
  toolResults.textContent = '';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const name = toolNames.selectedOptions[0].value;
  const inputArgs = inputArgsText.value;
  const frameId = parseInt(toolNames.selectedOptions[0].dataset.frameId);
  toolResults.textContent = await executeTool(tab.id, name, inputArgs, frameId).catch(
    (error) => `⚠️ Error: "${error}"`,
  );
};

async function executeTool(tabId, name, inputArgs, frameId) {
  let toolsReady;
  const toolsPromise = new Promise((resolve) => {
    toolsReady = resolve;
  });

  let targetTabId = tabId;
  let contentScriptReadyResolve;
  const contentScriptReadyPromise = new Promise((r) => { contentScriptReadyResolve = r; });

  const listener = (msg, sender) => {
    if (msg.type === 'contentScriptReady' && sender.tab) {
      if (sender.tab.id === tabId || sender.tab.openerTabId === tabId) {
        targetTabId = sender.tab.id;
        contentScriptReadyResolve();
      }
    }
    if (msg.tools && sender.tab?.id === targetTabId) {
      toolsReady();
    }
  };
  chrome.runtime.onMessage.addListener(listener);

  try {
    try {
      const result = await chrome.tabs.sendMessage(
        tabId,
        { action: 'EXECUTE_TOOL', name, inputArgs },
        { frameId },
      );
      if (result !== null) return result;
    } catch (error) {
      if (!/message channel (is )?closed/.test(error.message)) throw error;
    }

    // A navigation was triggered. The result will be on the next document,
    // which may live in a new tab if the tool opened one.
    await Promise.race([
      contentScriptReadyPromise,
      new Promise((r) => setTimeout(r, 2000)),
    ]);

    await Promise.race([
      toolsPromise,
      new Promise((r) => setTimeout(r, 2000)),
    ]);

    await waitForPageLoad(targetTabId);

    return await chrome.tabs.sendMessage(
      targetTabId,
      { action: 'GET_CROSS_DOCUMENT_SCRIPT_TOOL_RESULT' },
      // The original frameId only makes sense in the original tab.
      { frameId: targetTabId === tabId ? frameId : 0 },
    );
  } finally {
    chrome.runtime.onMessage.removeListener(listener);
  }
}

toolNames.onchange = updateDefaultValueForInputArgs;

function updateDefaultValueForInputArgs() {
  const inputSchema = toolNames.selectedOptions[0].dataset.inputSchema || '{}';
  const template = generateTemplateFromSchema(JSON.parse(inputSchema));
  inputArgsText.value = JSON.stringify(template, '', ' ');
}

// Initialize Gemini Live
initGeminiLive({
  micBtn,
  apiKeyBtn,
  getTools: () => currentTools,
  getConfig,
  executeTool,
  logPrompt,
  addToTrace: (o) => trace.push(o),
});

// Utils

function logPrompt(text) {
  const textNode = document.createTextNode(`${text}\n`);
  promptResults.appendChild(textNode);
  promptResults.scrollTop = promptResults.scrollHeight;
}

function renderAiResult(text) {
  if (!text) return;
  logPrompt(`AI result: ${text}\n`);

  // Detect code blocks: ```[lang][:filename]\n[code]```
  const codeBlockRegex = /```(?:([a-zA-Z0-9_-]+)(?:\s*:\s*([^\n\r]+))?)?\n([\s\S]*?)```/g;
  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    const rawLang = (match[1] || '').toLowerCase();
    const explicitFilename = match[2]?.trim();
    const code = match[3].trim();

    const lang = rawLang || (code.includes('import ') || code.includes('def ') ? 'python' : 'script');
    let filename = explicitFilename;
    if (!filename) {
      const commentMatch = code.match(/^(?:#|\/\/|\/\*)\s*([\w.-]+\.(?:py|sh|js|ts|json|yml|yaml))\b/m);
      if (commentMatch) {
        filename = commentMatch[1];
      } else if (lang === 'python' || lang === 'py') {
        filename = 'salesforce_monthly_audit.py';
      } else if (lang === 'sh' || lang === 'bash') {
        filename = 'run_audit.sh';
      } else if (lang === 'json') {
        filename = 'audit_report.json';
      } else {
        filename = 'automation_script.py';
      }
    }

    createScriptDeliveryCard(filename, lang, code);
  }
}

function createScriptDeliveryCard(filename, lang, code) {
  const card = document.createElement('div');
  card.className = 'script-delivery-card';

  const isPython = lang === 'python' || lang === 'py' || filename.endsWith('.py');
  const badgeText = isPython ? 'Python 3 • Zero Dependencies' : `${lang.toUpperCase()} Script`;

  card.innerHTML = `
    <div class="script-delivery-header">
      <div class="script-delivery-title">
        <span>⚡</span>
        <span>${escapeHtml(filename)}</span>
      </div>
      <span class="script-delivery-badge">${badgeText}</span>
    </div>
    <div class="script-delivery-actions">
      <button class="script-delivery-btn primary download-btn">⬇️ Download ${escapeHtml(filename)}</button>
      <button class="script-delivery-btn secondary copy-btn">📋 Copy Code</button>
      <button class="script-delivery-btn secondary toggle-btn">👁️ View Code</button>
    </div>
    <pre class="script-delivery-code" style="display: none;">${escapeHtml(code)}</pre>
    <div class="script-delivery-runbook">
      <strong>Run without WebMCP / Extension:</strong><br>
      <code>export RUBRIK_BASE_URL="https://your-org.my.rubrik.com"</code><br>
      <code>export RUBRIK_API_TOKEN="&lt;your-service-account-token&gt;"</code><br>
      <code>python3 ${escapeHtml(filename)}</code>
    </div>
  `;

  const downloadBtn = card.querySelector('.download-btn');
  downloadBtn.onclick = (e) => {
    e.stopPropagation();
    downloadFile(filename, code, isPython ? 'text/x-python' : 'text/plain');
  };

  const copyBtn = card.querySelector('.copy-btn');
  copyBtn.onclick = async (e) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(code);
    copyBtn.textContent = '✓ Copied!';
    setTimeout(() => {
      copyBtn.textContent = '📋 Copy Code';
    }, 2000);
  };

  const toggleBtn = card.querySelector('.toggle-btn');
  const codePre = card.querySelector('.script-delivery-code');
  toggleBtn.onclick = (e) => {
    e.stopPropagation();
    const isHidden = codePre.style.display === 'none';
    codePre.style.display = isHidden ? 'block' : 'none';
    toggleBtn.textContent = isHidden ? '🙈 Hide Code' : '👁️ View Code';
  };

  promptResults.appendChild(card);
  promptResults.scrollTop = promptResults.scrollHeight;
}

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getSystemInstructionText() {
  return [
    'You are an assistant embedded in a browser tab for Rubrik Security Cloud.',
    'User prompts typically refer to the current tab unless stated otherwise.',
    'Use the provided tools to query page content when you need it.',
    `Today's date is: ${getFormattedDate()}`,
    'CRITICAL RULE: Whenever the user provides a relative date (e.g., "next Monday", "tomorrow", "in 3 days"),  you must calculate the exact calendar date based on today\'s date.',
    'CRITICAL RULE: Do not try to use other tools than the available ones.',
    'AUTOMATION & SCRIPT DELIVERY RULE: When asked to audit, automate, or generate a script: first use the page tools to query live data and identify status or gaps. Then output a complete, standalone, production-ready Python script inside a ```python code block. The script MUST use only standard libraries (urllib.request, json, os, sys, datetime) with zero external pip dependencies. It should read credentials from RUBRIK_BASE_URL and RUBRIK_API_TOKEN environment variables and print a clean summary report.',
  ].join('\n');
}

function getFormattedDate() {
  const today = new Date();
  return today.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function getConfig() {
  const systemInstruction = [
    'You are an assistant embedded in a browser tab for Rubrik Security Cloud.',
    'User prompts typically refer to the current tab unless stated otherwise.',
    'Use the provided tools to query page content when you need it.',
    `Today's date is: ${getFormattedDate()}`,
    'CRITICAL RULE: Whenever the user provides a relative date (e.g., "next Monday", "tomorrow", "in 3 days"),  you must calculate the exact calendar date based on today\'s date.',
    'CRITICAL RULE: Do not try to use other tools than the available ones.',
    'AUTOMATION & SCRIPT DELIVERY RULE: When asked to audit, automate, or generate a script: first use the page tools to query live data and identify status or gaps. Then output a complete, standalone, production-ready Python script inside a ```python code block. The script MUST use only standard libraries (urllib.request, json, os, sys, datetime) with zero external pip dependencies. It should read credentials from RUBRIK_BASE_URL and RUBRIK_API_TOKEN environment variables and print a clean summary report.',
  ];

  const functionDeclarations = (currentTools || []).map((tool) => {
    return {
      name: `_${tool.frameId}_${tool.name}`,
      description: tool.description,
      parametersJsonSchema: tool.inputSchema
        ? (typeof tool.inputSchema === 'string' ? JSON.parse(tool.inputSchema) : tool.inputSchema)
        : { type: 'object', properties: {} },
    };
  });
  const tools = functionDeclarations.length > 0 ? [{ functionDeclarations }] : [];
  return { systemInstruction, tools };
}

function generateTemplateFromSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    return null;
  }

  if (schema.hasOwnProperty('const')) {
    return schema.const;
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return generateTemplateFromSchema(schema.oneOf[0]);
  }

  if (schema.hasOwnProperty('default')) {
    return schema.default;
  }

  if (Array.isArray(schema.examples) && schema.examples.length > 0) {
    return schema.examples[0];
  }

  switch (schema.type) {
    case 'object':
      const obj = {};
      if (schema.properties) {
        Object.keys(schema.properties).forEach((key) => {
          obj[key] = generateTemplateFromSchema(schema.properties[key]);
        });
      }
      return obj;

    case 'array':
      if (schema.items) {
        return [generateTemplateFromSchema(schema.items)];
      }
      return [];

    case 'string':
      if (schema.enum && schema.enum.length > 0) {
        return schema.enum[0];
      }
      if (schema.format === 'date') {
        return new Date().toISOString().substring(0, 10);
      }
      // yyyy-MM-ddThh:mm:ss.SSS
      if (
        schema.format ===
        '^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\\.[0-9]{1,3})?)?$'
      ) {
        return new Date().toISOString().substring(0, 23);
      }
      // yyyy-MM-ddThh:mm:ss
      if (
        schema.format ===
        '^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'
      ) {
        return new Date().toISOString().substring(0, 19);
      }
      // yyyy-MM-ddThh:mm
      if (schema.format === '^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]$') {
        return new Date().toISOString().substring(0, 16);
      }
      // yyyy-MM
      if (schema.format === '^[0-9]{4}-(0[1-9]|1[0-2])$') {
        return new Date().toISOString().substring(0, 7);
      }
      // yyyy-Www
      if (schema.format === '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$') {
        return `${new Date().toISOString().substring(0, 4)}-W01`;
      }
      // HH:mm:ss.SSS
      if (schema.format === '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\\.[0-9]{1,3})?)?$') {
        return new Date().toISOString().substring(11, 23);
      }
      // HH:mm:ss
      if (schema.format === '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$') {
        return new Date().toISOString().substring(11, 19);
      }
      // HH:mm
      if (schema.format === '^([01][0-9]|2[0-3]):[0-5][0-9]$') {
        return new Date().toISOString().substring(11, 16);
      }
      if (schema.format === '^#[0-9a-zA-Z]{6}$') {
        return '#ff00ff';
      }
      if (schema.format === 'tel') {
        return '123-456-7890';
      }
      if (schema.format === 'email') {
        return 'user@example.com';
      }
      return 'example_string';

    case 'number':
    case 'integer':
      if (schema.minimum !== undefined) return schema.minimum;
      return 0;

    case 'boolean':
      return false;

    case 'null':
      return null;

    default:
      return {};
  }
}

function waitForPageLoad(tabId) {
  return new Promise((resolve) => {
    let timeoutId;
    const done = () => {
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') done();
    };

    timeoutId = setTimeout(done, 5000); // resolve rather than reject to avoid crashing the AI loop
    chrome.tabs.onUpdated.addListener(listener);

    // The tab may already be done loading, or gone; don't wait on the
    // timeout for those.
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') done();
    }).catch(done);
  });
}

document.querySelectorAll('.collapsible-header').forEach((header) => {
  header.addEventListener('click', () => {
    header.classList.toggle('collapsed');
    const content = header.nextElementSibling;
    if (content?.classList.contains('section-content')) {
      content.classList.toggle('is-hidden');
    }
  });
});
