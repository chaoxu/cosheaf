// `pnpm <script> -- --flag` forwards a lone `--` separator in argv; Commander
// would parse it as an unexpected operand. Drop it before .parse(). Shared by
// the workbench pack/release/update scripts so the forwarding rule lives in one
// place.
export function argvWithoutForwardedDashDash() {
  return process.argv.filter((a, i) => !(i >= 2 && a === "--"));
}
