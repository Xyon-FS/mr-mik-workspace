const developmentExtension = /\.(?:asm|asmdef|asmref|bash|bat|c|cc|cginc|clj|cljs|cmd|cmake|compute|cpp|cs|csproj|css|cxx|dart|frag|fs|fsproj|gd|glsl|go|gradle|groovy|h|hpp|hlsl|hlsli|java|js|jsx|kt|kts|less|lua|mjs|php|pl|ps1|py|rb|rs|sass|scala|scss|sh|shader|slang|sln|sql|svelte|swift|ts|tsx|vb|vert|vue|wgsl|zig)$/i;

export function isDevelopmentFile(file) {
  return developmentExtension.test(file) || /(?:^|[\\/])(?:CMakeLists\.txt|Dockerfile|Makefile)$/i.test(file);
}

export function splitFileLink(href) {
  const hash = href.indexOf('#');
  const file = hash < 0 ? href : href.slice(0, hash);
  const fragment = hash < 0 ? '' : href.slice(hash + 1);
  const suffix = /:(\d+)(?::(\d+)|-\d+)?$/.exec(file);
  const anchor = /^L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i.exec(fragment);
  const location = anchor || suffix;
  const line = Number(location?.[1]), column = Number(location?.[2]);
  return {
    file: suffix ? file.slice(0, suffix.index) : file,
    line: Number.isSafeInteger(line) && line > 0 ? line : undefined,
    column: Number.isSafeInteger(column) && column > 0 ? column : undefined,
  };
}
