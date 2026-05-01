export type LexicalProfile = {
  readonly synonymGroups: readonly (readonly string[])[]
  readonly pathStopwords: ReadonlySet<string>
}
