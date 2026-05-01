export type RepoResolver = {
  fileExists: (path: string) => boolean
  findFileForClass: (className: string) => string | null
  findMethodKey: (ref: string) => string | null
}
