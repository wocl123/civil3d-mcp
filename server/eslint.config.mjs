// 코드 모양 규칙(가독성). 동작에 관한 규칙은 넣지 않는다 — 그건 tsc와 시험이 맡는다.
// 규칙의 이유는 docs/코드_스타일.md 참고.
//   npm run lint        규칙에 어긋난 곳 보기
//   npm run lint:fix    자동으로 고칠 수 있는 것(중괄호, 빈 줄) 고치기
import tseslint from "typescript-eslint";
import stylistic from "@stylistic/eslint-plugin";

export default [
  {
    files: ["src/**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    plugins: { "@stylistic": stylistic },
    rules: {
      // if/for/while 본문은 한 줄이어도 중괄호로 감싸고 다음 줄에 쓴다.
      curly: ["error", "all"],
      "@stylistic/brace-style": ["error", "1tbs", { allowSingleLine: false }],
      "@stylistic/max-statements-per-line": ["error", { max: 1 }],
      "@stylistic/indent": ["error", 2, { SwitchCase: 1, flatTernaryExpressions: true, offsetTernaryExpressions: false }],
      "@stylistic/no-trailing-spaces": "error",

      // 블록(if, for, 함수 등)이 끝나면 빈 줄을 두고 다음 단계로 넘어간다.
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "block-like", next: "*" }
      ],

      // 한 줄은 120자까지. 긴 글(문자열·주석)과 정규식은 억지로 쪼개지 않는다.
      "@stylistic/max-len": [
        "warn",
        {
          code: 120,
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
          ignoreComments: true,
          ignoreUrls: true,
          ignoreRegExpLiterals: true
        }
      ]
    }
  }
];
