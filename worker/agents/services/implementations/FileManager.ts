import { IFileManager } from '../interfaces/IFileManager';
import { IStateManager } from '../interfaces/IStateManager';
import { FileOutputType } from '../../schemas';
import { TemplateDetails } from '../../../services/sandbox/sandboxTypes';
import { FileProcessing } from '../../domain/pure/FileProcessing';

/**
 * Manages file operations for code generation
 * Handles both template and generated files
 */
export class FileManager implements IFileManager {
    constructor(
        private stateManager: IStateManager
    ) {}

    getTemplateFile(path: string): { filePath: string; fileContents: string } | null {
        const state = this.stateManager.getState();
        return state.templateDetails?.files?.find(file => file.filePath === path) || null;
    }

    getGeneratedFile(path: string): FileOutputType | null {
        const state = this.stateManager.getState();
        return state.generatedFilesMap[path] || null;
    }

    getAllFiles(): FileOutputType[] {
        const state = this.stateManager.getState();
        return FileProcessing.getAllFiles(state.templateDetails, state.generatedFilesMap);
    }

    saveGeneratedFile(file: FileOutputType): void {
        const state = this.stateManager.getState();
        this.stateManager.setState({
            ...state,
            generatedFilesMap: {
                ...state.generatedFilesMap,
                [file.filePath]: {
                    ...file,
                    last_hash: '',
                    last_modified: Date.now(),
                    unmerged: []
                }
            }
        });
    }

    saveGeneratedFiles(files: FileOutputType[]): void {
        const state = this.stateManager.getState();
        const newFilesMap = { ...state.generatedFilesMap };
        
        for (const file of files) {
            newFilesMap[file.filePath] = {
                ...file,
                last_hash: '',
                last_modified: Date.now(),
                unmerged: []
            };
        }
        
        this.stateManager.setState({
            ...state,
            generatedFilesMap: newFilesMap
        });
    }

    deleteFiles(filePaths: string[]): void {
        const state = this.stateManager.getState();
        const newFilesMap = { ...state.generatedFilesMap };
        
        for (const filePath of filePaths) {
            delete newFilesMap[filePath];
        }
        
        this.stateManager.setState({
            ...state,
            generatedFilesMap: newFilesMap
        });
    }

    getFile(path: string): FileOutputType | null {
        const generatedFile = this.getGeneratedFile(path);
        if (generatedFile) {
            return generatedFile;
        }
        
        const templateFile = this.getTemplateFile(path);
        if (!templateFile) {
            return null;
        }
        return {...templateFile, filePurpose: 'Template file'};
    }
    
    getFileContents(path: string): string {
        const generatedFile = this.getGeneratedFile(path);
        if (generatedFile) {
            return generatedFile.fileContents;
        }
        
        const templateFile = this.getTemplateFile(path);
        return templateFile?.fileContents || '';
    }

    fileExists(path: string): boolean {
        return !!this.getGeneratedFile(path) || !!this.getTemplateFile(path);
    }

    getGeneratedFilePaths(): string[] {
        const state = this.stateManager.getState();
        return Object.keys(state.generatedFilesMap);
    }

    getTemplateDetails(): TemplateDetails | undefined {
        const state = this.stateManager.getState();
        return state.templateDetails;
    }

    getGeneratedFilesMap(): Record<string, FileOutputType> {
        const state = this.stateManager.getState();
        return state.generatedFilesMap;
    }

    getGeneratedFiles(): FileOutputType[] {
        const state = this.stateManager.getState();
        return Object.values(state.generatedFilesMap);
    }
}