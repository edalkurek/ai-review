import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { ReviewCoordinator } from '../review/reviewCoordinator';
import { SecretStore } from '../secrets';
import { BitbucketSetupInput, parseBitbucketSetupInput } from './bitbucketSetupData';

const CONFIG_SECTION = 'bitbucketAiReview';
let currentPanel: vscode.WebviewPanel | undefined;

interface SetupViewState {
  baseUrl: string;
  extraInstructions: string;
  modelName: string;
  modelBaseUrl: string;
  bitbucketTokenStored: boolean;
  modelApiKeyStored: boolean;
  automaticReviewEnabled: boolean;
  automaticReviewIntervalMinutes: number;
  repoInstructions: Record<string, string>;
  instructionsRepository: string;
  instructionsBranch: string;
}

export async function openBitbucketSetup(
  secrets: SecretStore,
  coordinator: ReviewCoordinator,
  output: vscode.LogOutputChannel,
): Promise<void> {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.One);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'bitbucketAiReview.setup',
    'YKB AI Review: Ayarlar',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: false },
  );
  currentPanel = panel;
  panel.onDidDispose(() => { currentPanel = undefined; });
  panel.webview.html = setupHtml(await readViewState(secrets));

  panel.webview.onDidReceiveMessage(async (message: unknown) => {
    if (typeof message === 'object' && message !== null) {
      const action = (message as { action?: string }).action;
      if (action === 'openVsCodeSettings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:ykb.bitbucket-ai-review');
        return;
      }
      if (action === 'fetchRepos') {
        try {
          const repos = await coordinator.listRepositories();
          await panel.webview.postMessage({ type: 'repos', repos: repos.map(r => ({ ...r, key: `${new URL(r.baseUrl).host}/${r.provider === 'cloud' ? r.workspace : r.projectKey}/${r.slug}`.toLowerCase() })) });
        } catch (error) {
          output.error(`Repo listesi alınamadı: ${safeMessage(error)}`);
        }
        return;
      }
    }
    try {
      const input = parseBitbucketSetupInput(message);
      await postStatus(panel, 'working', input.action === 'test'
        ? 'Ayarlar kaydediliyor ve Bitbucket bağlantısı test ediliyor…'
        : 'Ayarlar güvenli şekilde kaydediliyor…');
      await saveSetup(input, secrets);
      if (input.action === 'test') {
        const pullRequests = await coordinator.listPullRequests();
        await postStatus(panel, 'success', `Bağlantı başarılı. ${pullRequests.length} açık PR bulundu.`);
      } else {
        await postStatus(panel, 'success', 'Ayarlar ve gizli anahtarlar güvenli şekilde kaydedildi.');
      }
      output.info('Eklenti ayarları güvenli kurulum ekranından güncellendi.');
    } catch (error) {
      const messageText = safeMessage(error);
      output.error(`Kurulum işlemi başarısız: ${messageText}`);
      await postStatus(panel, 'error', messageText);
    }
  });
}

const DEFAULT_BITBUCKET_URL = 'https://sdlc.yapikredi.com.tr/bitbucket';
const DEFAULT_MODEL_URL = 'https://bifrost-proxy-server-dsp-ddi.apps.lan-dev-dc1-ocp.yapikredi.com.tr/v1';
const DEFAULT_MODEL_NAME = 'cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit';

async function readViewState(secrets: SecretStore): Promise<SetupViewState> {
  const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    baseUrl: configuration.get<string>('bitbucket.baseUrl', '') || DEFAULT_BITBUCKET_URL,
    extraInstructions: configuration.get<string>('review.extraInstructions', ''),
    modelName: configuration.get<string>('model.name', '') || DEFAULT_MODEL_NAME,
    modelBaseUrl: configuration.get<string>('model.baseUrl', '') || DEFAULT_MODEL_URL,
    bitbucketTokenStored: Boolean((await secrets.get('bitbucketToken')) || configuration.get<string>('bitbucket.token', '').trim()),
    modelApiKeyStored: Boolean((await secrets.get('modelApiKey')) || configuration.get<string>('model.apiKey', '').trim()),
    automaticReviewEnabled: configuration.get<boolean>('automaticReview.enabled', false),
    automaticReviewIntervalMinutes: configuration.get<number>('automaticReview.intervalMinutes', 5),
    repoInstructions: configuration.get<Record<string, string>>('review.repoInstructions', {}),
    instructionsRepository: configuration.get<string>('review.instructionsRepository', ''),
    instructionsBranch: configuration.get<string>('review.instructionsBranch', ''),
  };
}

async function saveSetup(input: BitbucketSetupInput, secrets: SecretStore): Promise<void> {
  const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
  if ((input.action === 'test' || input.automaticReviewEnabled) && !input.bitbucketToken && !(await secrets.get('bitbucketToken')) && !configuration.get<string>('bitbucket.token', '').trim()) {
    throw new Error('Bitbucket Access Token gereklidir.');
  }
  if (!input.modelName) throw new Error('AI model ID’si gereklidir.');

  const target = vscode.ConfigurationTarget.Global;
  await configuration.update('automaticReview.enabled', false, target);
  await configuration.update('bitbucket.baseUrl', input.baseUrl, target);
  await configuration.update('review.extraInstructions', input.extraInstructions, target);
  await configuration.update('model.name', input.modelName, target);
  await configuration.update('model.baseUrl', input.modelBaseUrl, target);
  if (input.bitbucketToken) await secrets.set('bitbucketToken', input.bitbucketToken);
  if (input.modelApiKey) await secrets.set('modelApiKey', input.modelApiKey);
  await configuration.update('automaticReview.intervalMinutes', input.automaticReviewIntervalMinutes, target);
  await configuration.update('automaticReview.enabled', input.automaticReviewEnabled, target);
  await configuration.update('review.repoInstructions', input.repoInstructions, target);
  await configuration.update('review.instructionsRepository', input.instructionsRepository, target);
  await configuration.update('review.instructionsBranch', input.instructionsBranch, target);
}

async function postStatus(
  panel: vscode.WebviewPanel,
  kind: 'working' | 'success' | 'error',
  message: string,
): Promise<void> {
  await panel.webview.postMessage({ type: 'status', kind, message });
}

function setupHtml(state: SetupViewState): string {
  const nonce = randomBytes(18).toString('base64');
  const bitbucketTokenHint = state.bitbucketTokenStored
    ? 'Kayıtlı Access Token var; değiştirmeyecekseniz boş bırakın.'
    : 'Bitbucket’tan aldığınız Access Token SecretStorage’da saklanır.';
  const modelKeyHint = state.modelApiKeyStored
    ? 'Kayıtlı kişisel API key var; değiştirmeyecekseniz boş bırakın.'
    : 'Kişisel model API anahtarınızı girin. SecretStorage’da saklanır.';

  return `<!doctype html><html lang="tr"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <style nonce="${nonce}">
      body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);max-width:760px;padding:24px;margin:auto}
      h1{font-size:24px}.lead,small{color:var(--vscode-descriptionForeground)}.lead{margin-bottom:24px}
      .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.wide{grid-column:1/-1}.section{border-top:1px solid var(--vscode-panel-border);margin-top:8px;padding-top:12px}.section h2{margin:0}
      label{display:block;font-weight:600;margin-bottom:6px}input,textarea,select{box-sizing:border-box;width:100%;padding:8px;border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground)}textarea{min-height:90px;resize:vertical}
      .check{display:flex;align-items:center;gap:8px;font-weight:500}.check input{width:auto;margin:0}small{display:block;margin-top:5px}.actions{display:flex;gap:10px;margin-top:24px}
      button{border:0;padding:9px 14px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button:disabled{opacity:.6;cursor:wait}
      #status{margin-top:18px;padding:10px;border-left:3px solid var(--vscode-panel-border)}#status.success{border-color:var(--vscode-testing-iconPassed)}#status.error{border-color:var(--vscode-errorForeground)}
      @media(max-width:600px){.grid{grid-template-columns:1fr}.wide{grid-column:auto}}
    </style></head><body>
    <h1>YKB AI Review ayarları</h1>
    <p class="lead">Bitbucket Server/Data Center ve AI model servisi bağlantısını yapılandırın.</p>
    <form id="setup"><div class="grid">
      <div><label class="check" for="automaticReviewEnabled"><input id="automaticReviewEnabled" type="checkbox"${state.automaticReviewEnabled ? ' checked' : ''}> Auto-Review: Enabled</label></div>
      <div><label for="automaticReviewIntervalMinutes">Auto-Review: Interval Minutes</label><input id="automaticReviewIntervalMinutes" type="number" min="1" max="1440" required value="${state.automaticReviewIntervalMinutes}"></div>
      <div class="wide"><label for="baseUrl">Bitbucket Base URL</label><input id="baseUrl" type="url" required value="${escapeAttribute(state.baseUrl)}" placeholder="https://sdlc.yapikredi.com.tr/bitbucket"><small>Bitbucket Server/Data Center kök adresi.</small></div>
      <div class="wide"><label for="extraInstructions">Genel Extra Instructions</label><textarea id="extraInstructions" placeholder="Tüm projeler için geçerli ekstra review kuralları.">${escapeHtml(state.extraInstructions)}</textarea></div>

      <div class="wide section"><h2>Ortak Talimat Reposu</h2></div>
      <div class="wide"><label for="instructionsRepository">Talimat reposu adresi</label><input id="instructionsRepository" type="url" value="${escapeAttribute(state.instructionsRepository)}" placeholder="https://sdlc.yapikredi.com.tr/bitbucket/projects/AI/repos/review-instructions"><small>Ekipçe paylaşılan talimatlar: <code>general.md</code> tüm repolara, <code>projects/&lt;PROJE&gt;/general.md</code> projeye, <code>projects/&lt;PROJE&gt;/repos/&lt;repo&gt;.md</code> tek repoya uygulanır. Aşağıdaki kişisel talimatlar bunlardan sonra eklenir. Boş bırakılırsa kullanılmaz.</small></div>
      <div><label for="instructionsBranch">Dal</label><input id="instructionsBranch" type="text" value="${escapeAttribute(state.instructionsBranch)}" placeholder="varsayılan dal"></div>

      <div class="wide section">
        <h2>Repo Özel Talimatları</h2>
        <div style="display:flex; gap:10px; margin-bottom:10px;">
          <input type="text" id="repoSearch" placeholder="Repo ara veya seç..." autocomplete="off">
          <button type="button" id="btnFetchRepos" class="secondary">Repoları Getir</button>
        </div>
        <div id="repoDropdown" style="display:none; max-height:200px; overflow-y:auto; border:1px solid var(--vscode-input-border); background:var(--vscode-input-background); margin-bottom:10px;"></div>
        <div id="selectedRepoContainer" style="display:none; margin-bottom:10px; padding:10px; border:1px solid var(--vscode-panel-border); background:var(--vscode-editor-inactiveSelectionBackground);">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <strong id="selectedRepoLabel"></strong>
            <button type="button" id="btnRemoveRepo" class="secondary" style="padding:4px 8px; font-size:12px;">Kaldır</button>
          </div>
          <textarea id="repoExtraInstructions" placeholder="Bu repo için özel talimatlar..." style="min-height:60px;"></textarea>
          <div style="text-align:right; margin-top:8px;">
            <button type="button" id="btnSaveRepoInstruction" style="padding:4px 8px; font-size:12px;">Ekle / Güncelle</button>
          </div>
        </div>
        <div id="repoInstructionsList"></div>
      </div>
      
      <div class="wide"><label for="bitbucketToken">Bitbucket Access Token</label><input id="bitbucketToken" type="password" autocomplete="new-password" placeholder="${state.bitbucketTokenStored ? '•••••••• (kayıtlı)' : 'Bitbucket Access Token'}"><small>${escapeHtml(bitbucketTokenHint)}</small></div>
      <div class="wide section"><h2>AI Model ve Erişim Tanımı</h2></div>
      <div>
        <label for="modelPreset">Model Seçimi</label>
        <select id="modelPreset">
          <option value="cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit">Qwen Custom (cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit)</option>
          <option value="openai/gpt-oss-120b">Gpt Oss (openai/gpt-oss-120b)</option>
          <option value="custom">Özel Model Tanımla…</option>
        </select>
        <small>Hazır modellerden birini veya özel model seçin.</small>
      </div>
      <div id="customModelGroup">
        <label for="modelName">Model Adı / ID</label>
        <input id="modelName" required value="${escapeAttribute(state.modelName)}" placeholder="cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit">
        <small>Kullanılacak model kimliği.</small>
      </div>
      <div class="wide">
        <label for="modelBaseUrl">AI Model Base URL</label>
        <input id="modelBaseUrl" type="url" required value="${escapeAttribute(state.modelBaseUrl)}" placeholder="https://bifrost-proxy-server-dsp-ddi.apps.lan-dev-dc1-ocp.yapikredi.com.tr/v1">
        <small>OpenAI uyumlu model servisinin API adresi (düzenlenebilir).</small>
      </div>
      <div class="wide">
        <label for="modelApiKey">Kişisel Model API Key</label>
        <input id="modelApiKey" type="password" autocomplete="new-password" placeholder="${state.modelApiKeyStored ? '•••••••• (kayıtlı)' : 'sk-bf-...' }"><small>${escapeHtml(modelKeyHint)}</small>
      </div>
    </div><div class="actions">
      <button type="button" data-action="save">Güvenli kaydet</button>
      <button type="button" class="secondary" data-action="test">Kaydet ve Bitbucket bağlantısını test et</button>
      <button type="button" class="secondary" id="openSettingsBtn" style="margin-left:auto;">⚙️ VS Code Standart Ayarlarında Aç</button>
    </div></form><div id="status" role="status" aria-live="polite">Henüz işlem yapılmadı.</div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi(); const byId = (id) => document.getElementById(id);
      byId('openSettingsBtn').addEventListener('click', () => {
        vscode.postMessage({ action: 'openVsCodeSettings' });
      });
      const buttons = [...document.querySelectorAll('button[data-action]')];
      const PRESETS = ['cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit', 'openai/gpt-oss-120b'];
      const presetEl = byId('modelPreset');
      const modelInput = byId('modelName');
      const customGroup = byId('customModelGroup');

      function syncPresetState() {
        const val = modelInput.value.trim();
        if (PRESETS.includes(val)) {
          presetEl.value = val;
          customGroup.style.display = 'none';
        } else {
          presetEl.value = 'custom';
          customGroup.style.display = 'block';
        }
      }

      presetEl.addEventListener('change', () => {
        if (presetEl.value === 'custom') {
          customGroup.style.display = 'block';
          if (PRESETS.includes(modelInput.value.trim())) {
            modelInput.value = '';
          }
          modelInput.focus();
        } else {
          customGroup.style.display = 'none';
          modelInput.value = presetEl.value;
        }
      });

      window.repoInstructions = ${JSON.stringify(state.repoInstructions || {})};
      window.availableRepos = [];
      window.selectedRepo = null;

      function renderRepoList() {
        const list = byId('repoInstructionsList');
        list.innerHTML = '';
        for (const [key, instruction] of Object.entries(window.repoInstructions)) {
          const div = document.createElement('div');
          div.style.cssText = 'padding:8px; margin-bottom:8px; border:1px solid var(--vscode-panel-border);';
          div.innerHTML = \`<div style="display:flex; justify-content:space-between; margin-bottom:4px;">
            <strong>\${escapeHtml(key)}</strong>
            <button type="button" class="secondary btn-delete-repo" data-key="\${escapeAttribute(key)}" style="padding:2px 6px; font-size:11px;">Sil</button>
          </div>
          <div style="font-size:12px; white-space:pre-wrap; color:var(--vscode-descriptionForeground);">\${escapeHtml(instruction)}</div>\`;
          list.appendChild(div);
        }
        document.querySelectorAll('.btn-delete-repo').forEach(btn => {
          btn.addEventListener('click', (e) => {
            const key = e.target.dataset.key;
            delete window.repoInstructions[key];
            renderRepoList();
          });
        });
      }

      byId('btnFetchRepos').addEventListener('click', () => {
        byId('btnFetchRepos').disabled = true;
        byId('btnFetchRepos').textContent = 'Yükleniyor...';
        vscode.postMessage({ action: 'fetchRepos' });
      });

      byId('repoSearch').addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase();
        const dropdown = byId('repoDropdown');
        if (!q && window.availableRepos.length === 0) {
          dropdown.style.display = 'none';
          return;
        }
        dropdown.style.display = 'block';
        dropdown.innerHTML = '';
        const filtered = window.availableRepos.filter(r => r.key.includes(q) || r.name.toLowerCase().includes(q)).slice(0, 50);
        if (filtered.length === 0) {
          dropdown.innerHTML = '<div style="padding:8px; color:var(--vscode-descriptionForeground);">Bulunamadı (Gerekirse repo keyini doğrudan yazıp seçebilirsiniz)</div>';
          if (q.includes('/')) {
            const div = document.createElement('div');
            div.style.cssText = 'padding:8px; cursor:pointer; color:var(--vscode-textLink-foreground);';
            div.textContent = \`Bunu kullan: \${q}\`;
            div.addEventListener('click', () => selectRepo({ key: q, name: q }));
            dropdown.appendChild(div);
          }
        } else {
          filtered.forEach(r => {
            const div = document.createElement('div');
            div.style.cssText = 'padding:8px; cursor:pointer; border-bottom:1px solid var(--vscode-panel-border);';
            div.textContent = \`\${r.name} (\${r.key})\`;
            div.addEventListener('click', () => selectRepo(r));
            dropdown.appendChild(div);
          });
        }
      });

      function selectRepo(r) {
        window.selectedRepo = r;
        byId('repoSearch').value = '';
        byId('repoDropdown').style.display = 'none';
        byId('selectedRepoContainer').style.display = 'block';
        byId('selectedRepoLabel').textContent = \`\${r.name} (\${r.key})\`;
        byId('repoExtraInstructions').value = window.repoInstructions[r.key] || '';
      }

      byId('btnRemoveRepo').addEventListener('click', () => {
        window.selectedRepo = null;
        byId('selectedRepoContainer').style.display = 'none';
      });

      byId('btnSaveRepoInstruction').addEventListener('click', () => {
        if (!window.selectedRepo) return;
        const val = byId('repoExtraInstructions').value.trim();
        if (val) {
          window.repoInstructions[window.selectedRepo.key] = val;
        } else {
          delete window.repoInstructions[window.selectedRepo.key];
        }
        renderRepoList();
        byId('btnRemoveRepo').click();
      });

      renderRepoList();

      buttons.forEach((button) => button.addEventListener('click', () => {
        const effectiveModel = presetEl.value === 'custom' ? modelInput.value.trim() : presetEl.value;
        if (!effectiveModel) {
          modelInput.setCustomValidity('Lütfen bir model seçin veya model adını girin.');
        } else {
          modelInput.setCustomValidity('');
        }
        if (!byId('setup').reportValidity()) return;
        buttons.forEach((item) => { item.disabled = true; });
        vscode.postMessage({ action: button.dataset.action, baseUrl: byId('baseUrl').value,
          extraInstructions: byId('extraInstructions').value, modelName: effectiveModel,
          modelBaseUrl: byId('modelBaseUrl').value, bitbucketToken: byId('bitbucketToken').value,
          modelApiKey: byId('modelApiKey').value, automaticReviewEnabled: byId('automaticReviewEnabled').checked,
          automaticReviewIntervalMinutes: Number(byId('automaticReviewIntervalMinutes').value), repoInstructions: window.repoInstructions,
          instructionsRepository: byId('instructionsRepository').value, instructionsBranch: byId('instructionsBranch').value });
      }));
      window.addEventListener('message', (event) => {
        if (!event.data) return;
        if (event.data.type === 'status') {
          const status = byId('status'); status.textContent = event.data.message; status.className = event.data.kind;
          buttons.forEach((item) => { item.disabled = event.data.kind === 'working'; });
          if (event.data.kind === 'success') { byId('bitbucketToken').value = ''; byId('modelApiKey').value = ''; }
        } else if (event.data.type === 'repos') {
          window.availableRepos = event.data.repos || [];
          byId('btnFetchRepos').disabled = false;
          byId('btnFetchRepos').textContent = 'Repoları Getir';
          byId('repoSearch').dispatchEvent(new Event('input'));
        }
      });
      function escapeHtml(str) { return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
      function escapeAttribute(str) { return String(str).replace(/"/g, '&quot;'); }
    </script></body></html>`;
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Bilinmeyen kurulum hatası.';
}
