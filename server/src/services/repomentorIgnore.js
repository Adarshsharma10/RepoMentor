function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globRegex(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegex(char);
    }
  }
  return new RegExp(`^${source}$`);
}

export function parseRepoIgnore(contents = '') {
  return contents.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
    .map(raw => {
      const negated = raw.startsWith('!');
      let pattern = negated ? raw.slice(1) : raw;
      const anchored = pattern.startsWith('/');
      if (anchored) pattern = pattern.slice(1);
      const directoryOnly = pattern.endsWith('/');
      if (directoryOnly) pattern = pattern.slice(0, -1);
      return { negated, anchored, directoryOnly, hasSlash: pattern.includes('/'), regex: globRegex(pattern) };
    });
}

function ruleMatches(rule, filePath) {
  const segments = filePath.split('/');
  const candidates = [];
  for (let index = 1; index <= segments.length; index += 1) {
    const candidate = segments.slice(0, index).join('/');
    const isDirectory = index < segments.length;
    if (!rule.directoryOnly || isDirectory) candidates.push(candidate);
  }

  if (rule.hasSlash || rule.anchored) return candidates.some(candidate => rule.regex.test(candidate));
  return candidates.some(candidate => rule.regex.test(candidate.split('/').at(-1)));
}

export function isRepoPathIgnored(filePath, rules) {
  let ignored = false;
  for (const rule of rules) {
    if (ruleMatches(rule, filePath)) ignored = !rule.negated;
  }
  return ignored;
}
