const MULTIPLIERS = {
  m: 'm',
  million: 'm',
  k: 'k',
  thousand: 'k',
  b: 'b',
  billion: 'b',
  '%': '%',
  x: 'x',
};

export function extractNumbers(text) {
  const matches =
    String(text ?? '').match(
      // Do not read the 3 in D3.js, the 6 in ES6, or the 8 in v3.8 as a
      // standalone metric. Decimals such as 2.5 still match from the first
      // digit because the lookbehind only rejects letters, digits, and dots.
      /(?<![A-Za-z0-9.])\d+(?:,\d{3})*(?:\.\d+)?(?:\s*(?:M|k|K|million|billion|thousand|%|[xX]))?(?![A-Za-z0-9])/g,
    ) ?? [];

  return matches.map((raw) => {
    const value = raw.replace(/,/g, '').replace(/\s+/g, '').toLowerCase();
    const match = value.match(
      /^(.*?)(million|billion|thousand|m|k|b|%|x)$/,
    );
    if (!match) return value;
    return `${match[1]}${MULTIPLIERS[match[2]]}`;
  });
}
