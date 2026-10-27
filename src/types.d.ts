// wrangler [[rules]] 把 .sql 作为文本模块导入（见 wrangler.toml），
// 这里为 TypeScript 提供模块声明
declare module '*.sql' {
  const content: string;
  export default content;
}
