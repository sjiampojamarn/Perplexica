const BLOCK_DANGEROUS_TAGS = [
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'template',
  'noscript',
  'form',
  'input',
  'button',
  'select',
  'textarea',
];

const VOID_DANGEROUS_TAGS = ['meta', 'link', 'base', 'frame'];

const blockTagWithContent = (tag: string): RegExp =>
  new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi');

const selfClosingTag = (tag: string): RegExp =>
  new RegExp(`<${tag}\\b[^>]*\\/>`, 'gi');

const openTag = (tag: string): RegExp =>
  new RegExp(`<${tag}\\b[^>]*>`, 'gi');

const EVENT_HANDLER_ATTR = /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

const URL_ATTRS = /\b(href|src|action|formaction|xlink:href|background)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;

const isDangerousScheme = (value: string): boolean => {
  const trimmed = value.trim().toLowerCase();

  if (trimmed.startsWith('javascript:') || trimmed.startsWith('vbscript:')) {
    return true;
  }

  return trimmed.startsWith('data:') && !trimmed.startsWith('data:image/');
};

export const sanitizeMarkdown = (markdown: string): string => {
  if (typeof markdown !== 'string' || markdown.length === 0) {
    return markdown;
  }

  let out = markdown;

  for (const tag of BLOCK_DANGEROUS_TAGS) {
    out = out.replace(blockTagWithContent(tag), '');
    out = out.replace(selfClosingTag(tag), '');
  }

  for (const tag of VOID_DANGEROUS_TAGS) {
    out = out.replace(openTag(tag), '');
  }

  out = out.replace(EVENT_HANDLER_ATTR, ' ');

  out = out.replace(URL_ATTRS, (match, attr: string, rawValue: string) => {
    if (isDangerousScheme(rawValue.replace(/^["']|["']$/g, ''))) {
      return `${attr}="#"`;
    }

    return match;
  });

  return out;
};
