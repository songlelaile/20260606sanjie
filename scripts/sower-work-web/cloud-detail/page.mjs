const words = {
  title: '长详情编辑', intro: '上传已有图片，调整顺序与宽度，保存并导出长图或分段 ZIP。', upload: '添加图片', projectTitle: '标题', width: '导出宽度（像素）', save: '保存', whole: '导出整图', slices: '导出分段 ZIP', preview: '预览', defaultTitle: '长详情', ready: '请选择图片开始编辑。', busy: '正在处理…', saved: '已保存。', exported: '导出完成，点击下方文件下载。', imported: '图片已导入并保存。', up: '上移', down: '下移', remove: '移除', sectionTitle: '分段标题', missing: '请先添加图片。', conflict: '项目已有新版本，请刷新后继续编辑。', failed: '操作失败：', count: '分段',
};
const errors = {
  DETAIL_CAPACITY_BUSY: '图片正在处理，请稍后重试。', DETAIL_RATE_LIMITED: '导入或导出较频繁，请一分钟后再试。',
  LOGIN_REQUIRED: '请重新登录网站后继续。', ADMIN_REQUIRED: '当前账号没有使用权限。', DETAIL_CLOUD_CONVERSATION_NOT_FOUND: '当前编辑会话不可用，请刷新重新创建。', DETAIL_PAGE_REVISION_CONFLICT: words.conflict, DETAIL_CLOUD_IMPORT_BUSY: '同一项目的图片还在导入，请稍后重试。', DETAIL_CLOUD_IMPORT_TOO_LARGE: '图片超过导入限制，请缩小图片或分批上传。', DETAIL_PAGE_EXPORT_TOO_LARGE: '长图超过导出限制，请降低宽度或减少分段。', DETAIL_CLOUD_IMPORT_ARGUMENT_INVALID: '请选择 PNG、JPG、WebP 或 AVIF 图片，每个项目最多 40 个分段。', DETAIL_PAGE_ARGUMENT_INVALID: '请检查标题、宽度和分段内容。', PRODUCTION_FILE_HASH_MISMATCH: '图片已改变，请重新上传。', DETAIL_CLOUD_FILE_FORBIDDEN: '这张图片不属于当前云端账号，请重新上传。', DETAIL_CLOUD_SOURCE_NOT_OWNED: '请通过当前账号上传原图后再添加。', DETAIL_CLOUD_SYMLINK_FORBIDDEN: '图片文件不可用，请重新上传。', FILE_SCOPE_FORBIDDEN: '文件不属于当前云端账号。', DETAIL_PAGE_EMPTY: words.missing,
};
for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = words[element.dataset.i18n];
document.title = `${words.title} · Sower Work`;
const $ = (id) => document.getElementById(id);
let conversationId, project, busy = false;
const streamUrl = (file) => `/sower-work/app/api/fs/stream?kind=local&path=${encodeURIComponent(file)}`;
function status(text, error = false) { $('status').textContent = text; $('status').dataset.error = String(error); }
async function api(route, body) {
  const response = await fetch(`/sower-work/app${route}`, { credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const envelope = await response.json();
  if (!response.ok || envelope.success === false) throw new Error(envelope.error?.code || `HTTP_${response.status}`);
  return envelope.data;
}
async function detail(body) { return api('/api/sower/detail-pages', { ...body, conversationId }); }
async function run(callback) {
  if (busy) return;
  busy = true;
  for (const element of document.querySelectorAll('button,input')) element.disabled = true;
  status(words.busy);
  try { await callback(); } catch (error) { status(words.failed + (errors[error.message] || (error.message === words.missing ? words.missing : '暂时无法完成，请稍后重试。')), true); }
  finally { busy = false; for (const element of document.querySelectorAll('button,input')) element.disabled = false; }
}
function render() {
  $('sections').replaceChildren(); $('preview').replaceChildren();
  if (!project) return;
  $('title').value = project.title; $('width').value = project.width;
  for (const [index, section] of project.sections.entries()) {
    const asset = section.versions.find((item) => item.id === section.selectedVersionId);
    const card = document.createElement('article'); card.className = 'section';
    const image = document.createElement('img'); image.src = streamUrl(asset.path); image.alt = section.title;
    const fields = document.createElement('div'); fields.className = 'fields';
    const label = document.createElement('label'); label.textContent = `${index + 1} · ${words.sectionTitle}`;
    const title = document.createElement('input'); title.value = section.title; title.maxLength = 200; title.addEventListener('input', () => { section.title = title.value; }); label.append(title); fields.append(label);
    const controls = document.createElement('div'); controls.className = 'controls';
    for (const [name, action] of [['up', () => { if (index) [project.sections[index - 1], project.sections[index]] = [project.sections[index], project.sections[index - 1]]; }], ['down', () => { if (index < project.sections.length - 1) [project.sections[index + 1], project.sections[index]] = [project.sections[index], project.sections[index + 1]]; }], ['remove', () => { project.sections.splice(index, 1); }]]) {
      const button = document.createElement('button'); button.textContent = words[name]; button.addEventListener('click', () => { capture(); action(); render(); }); controls.append(button);
    }
    fields.append(controls); card.append(image, fields); $('sections').append(card);
    const preview = document.createElement('img'); preview.src = image.src; preview.alt = section.title; $('preview').append(preview);
  }
}
function capture() { if (project) { project.title = $('title').value.trim() || words.defaultTitle; project.width = Number($('width').value); } }
async function save() {
  if (!project?.sections.length) throw new Error(words.missing);
  capture();
  const response = await detail({ action: 'save', expectedRevision: project.revision < 0 ? null : project.revision, project: { ...project, revision: Math.max(0, project.revision) } });
  project = response.project; render();
}
async function ensureConversation() {
  if (conversationId) return;
  const conversation = await api('/api/conversations', { type: 'aionrs', name: words.title, model: { provider_id: '', model: '' }, extra: {} });
  conversationId = conversation.id;
  sessionStorage.setItem('sower-cloud-detail-conversation', conversationId);
}
$('pictures').addEventListener('change', () => { const files = [...$('pictures').files]; void run(async () => {
  if (!files.length) return;
  if (files.length + (project?.sections.length || 0) > 40) throw new Error('DETAIL_CLOUD_IMPORT_ARGUMENT_INVALID');
  await ensureConversation();
  const uploaded = [];
  for (const file of files) {
    const extension = /\.(png|jpe?g|webp|avif)$/i.exec(file.name)?.[0];
    if (!extension) throw new Error('DETAIL_CLOUD_IMPORT_ARGUMENT_INVALID');
    const form = new FormData(); form.append('conversation_id', conversationId); form.append('file', file, `${crypto.randomUUID()}${extension.toLowerCase()}`);
    const response = await fetch('/sower-work/app/api/fs/upload', { method: 'POST', body: form, credentials: 'same-origin' });
    const value = await response.json(); if (!response.ok || value.success === false) throw new Error(value.error?.code || `HTTP_${response.status}`);
    uploaded.push({ path: value.data });
  }
  const imported = await detail({ action: 'import', files: uploaded });
  if (!project) project = { id: crypto.randomUUID(), conversationId, title: $('title').value.trim() || words.defaultTitle, width: Number($('width').value), revision: -1, sections: [], updatedAt: Date.now() };
  for (const [index, item] of imported.imported.entries()) {
    const asset = imported.assets.find((candidate) => candidate.path === item.path && candidate.sha256 === item.sha256);
    if (!asset) throw new Error('DETAIL_CLOUD_IMPORT_RESULT_MISSING');
    project.sections.push({ id: crypto.randomUUID(), title: files[index].name.slice(0, 200), selectedVersionId: asset.id, versions: [asset], editDraft: '' });
  }
  await save(); $('pictures').value = ''; status(words.imported);
}); });
$('save').addEventListener('click', () => { void run(async () => { await save(); status(words.saved); }); });
for (const format of ['whole', 'slices']) $(format).addEventListener('click', () => { void run(async () => {
  await save();
  const result = await detail({ action: 'export', projectId: project.id, expectedRevision: project.revision, format });
  $('downloads').replaceChildren();
  for (const file of result.files) { const link = document.createElement('a'); link.href = streamUrl(file.path); link.download = file.name; link.textContent = file.name; $('downloads').append(link); }
  status(words.exported);
}); });
$('title').value = words.defaultTitle;
status(words.ready);
const savedConversation = sessionStorage.getItem('sower-cloud-detail-conversation');
if (savedConversation && /^[\w-]{1,128}$/.test(savedConversation)) void run(async () => {
  conversationId = savedConversation;
  try { project = (await detail({ action: 'load' })).project; render(); status(project ? words.saved : words.ready); }
  catch { conversationId = undefined; sessionStorage.removeItem('sower-cloud-detail-conversation'); status(words.ready); }
});
window.__sowerCloudNotifyReady?.();
