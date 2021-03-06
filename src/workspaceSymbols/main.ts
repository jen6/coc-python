import { Disposable, languages, Uri, OutputChannel } from 'coc.nvim'
import { CancellationToken } from 'vscode-languageserver-protocol'
import { IApplicationShell, ICommandManager, IWorkspaceService } from '../common/application/types'
import { Commands, STANDARD_OUTPUT_CHANNEL } from '../common/constants'
import { isNotInstalledError } from '../common/helpers'
import { IFileSystem } from '../common/platform/types'
import { IProcessServiceFactory } from '../common/process/types'
import {
  IConfigurationService, IInstaller, InstallerResponse, IOutputChannel, Product
} from '../common/types'
import { IServiceContainer } from '../ioc/types'
import { Generator } from './generator'
import { WorkspaceSymbolProvider } from './provider'

const MAX_NUMBER_OF_ATTEMPTS_TO_INSTALL_AND_BUILD = 2

export class WorkspaceSymbols implements Disposable {
  private disposables: Disposable[]
  private generators: Generator[] = []
  private readonly outputChannel: OutputChannel
  private commandMgr: ICommandManager
  private fs: IFileSystem
  private workspace: IWorkspaceService
  private processFactory: IProcessServiceFactory
  private appShell: IApplicationShell
  private configurationService: IConfigurationService

  constructor(private serviceContainer: IServiceContainer) {
    this.outputChannel = this.serviceContainer.get<OutputChannel>(IOutputChannel, STANDARD_OUTPUT_CHANNEL)
    this.commandMgr = this.serviceContainer.get<ICommandManager>(ICommandManager)
    this.fs = this.serviceContainer.get<IFileSystem>(IFileSystem)
    this.workspace = this.serviceContainer.get<IWorkspaceService>(IWorkspaceService)
    this.processFactory = this.serviceContainer.get<IProcessServiceFactory>(IProcessServiceFactory)
    this.appShell = this.serviceContainer.get<IApplicationShell>(IApplicationShell)
    this.configurationService = this.serviceContainer.get<IConfigurationService>(IConfigurationService)
    this.disposables = []
    this.disposables.push(this.outputChannel)
    this.registerCommands()
    this.initializeGenerators()
    languages.registerWorkspaceSymbolProvider(['python'], new WorkspaceSymbolProvider(this.fs, this.commandMgr, this.generators))
    // this.disposables.push(this.workspace.onDidChangeWorkspaceFolders(() => this.initializeGenerators()))
  }
  public dispose() {
    this.disposables.forEach(d => d.dispose())
  }
  private initializeGenerators() {
    while (this.generators.length > 0) {
      const generator = this.generators.shift()!
      generator.dispose()
    }

    if (Array.isArray(this.workspace.workspaceFolders)) {
      this.workspace.workspaceFolders.forEach(wkSpc => {
        this.generators.push(new Generator(Uri.parse(wkSpc.uri), this.outputChannel, this.appShell, this.fs, this.processFactory, this.configurationService))
      })
    }
  }

  private registerCommands() {
    this.disposables.push(
      this.commandMgr.registerCommand(
        Commands.Build_Workspace_Symbols,
        async (rebuild = true, token?: CancellationToken) => {
          const promises = this.buildWorkspaceSymbols(rebuild, token)
          return Promise.all(promises)
        }))
  }

  // tslint:disable-next-line:no-any
  private buildWorkspaceSymbols(rebuild = true, token?: CancellationToken): Promise<any>[] {
    if (token && token.isCancellationRequested) {
      return []
    }
    if (this.generators.length === 0) {
      return []
    }

    let promptPromise: Promise<InstallerResponse>
    let promptResponse: InstallerResponse
    return this.generators.map(async generator => {
      if (!generator.enabled) {
        return
      }
      const exists = await this.fs.fileExists(generator.tagFilePath)
      // If file doesn't exist, then run the ctag generator,
      // or check if required to rebuild.
      if (!rebuild && exists) {
        return
      }
      for (let counter = 0; counter < MAX_NUMBER_OF_ATTEMPTS_TO_INSTALL_AND_BUILD; counter += 1) {
        try {
          await generator.generateWorkspaceTags()
          return
        } catch (error) {
          if (!isNotInstalledError(error)) {
            this.outputChannel.show()
            return
          }
        }
        if (!token || token.isCancellationRequested) {
          return
        }
        // Display prompt once for all workspaces.
        if (promptPromise) {
          promptResponse = await promptPromise
          continue
        } else {
          const installer = this.serviceContainer.get<IInstaller>(IInstaller)
          const uri = this.workspace.hasWorkspaceFolders ? Uri.parse(this.workspace.workspaceFolders![0]!.uri) : undefined
          promptPromise = installer.promptToInstall(Product.ctags, uri)
          promptResponse = await promptPromise
        }
        if (promptResponse !== InstallerResponse.Installed || (!token || token.isCancellationRequested)) {
          return
        }
      }
    })
  }
}
