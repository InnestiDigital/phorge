export type ProfileDetector = {
  detect(repoPath: string): Promise<boolean>
}
