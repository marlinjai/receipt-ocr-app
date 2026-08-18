import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Build artifacts. Without these, `pnpm lint` linted generated output and
    // reported 24022 problems / 690 errors, of which only 6 were in src/, which
    // made the lint gate useless: nobody can find a real error in that. The
    // .open-next and .wrangler trees are leftovers from the retired Cloudflare
    // Workers stack and are not regenerated any more; docs-dist is the built
    // docs site.
    ".open-next/**",
    ".wrangler/**",
    "docs-dist/**",
    "coverage/**",
  ]),
]);

export default eslintConfig;
