export function gameHttpUrl(mode: string): string {
  return mode === 'local' ? 'http://localhost:8888' : 'https://chess_api.w3connect.org'
}

export function gameWsUrl(mode: string): string {
  return mode === 'local' ? 'ws://localhost:8888/ws' : 'wss://chess_api.w3connect.org/ws'
}
