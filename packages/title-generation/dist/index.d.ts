export declare const MAX_GENERATED_TITLE_CHARACTERS = 60;
export declare const CONVERSATION_TITLE_REGENERATION_PROMPT_CHARACTERS = 64;
type TitleSubject = "conversation" | "project";
type TitleGenerationPromptInput = Readonly<{
    prompt: string;
    subject: TitleSubject;
}>;
export type TitleGenerationExecutionRequest = Readonly<{
    prompt: string;
    maxOutputTokens: number;
    temperature: number;
}>;
type TitleGenerationTextResult = Readonly<{
    text: string;
}>;
export type GenerateTitleInput<Result extends TitleGenerationTextResult> = TitleGenerationPromptInput & Readonly<{
    execute: (request: TitleGenerationExecutionRequest) => Promise<Result>;
}>;
export type GenerateTitleResult<Result extends TitleGenerationTextResult> = Readonly<{
    result: Result;
    title: string | null;
}>;
/** Build an immediate deterministic label while model generation runs. */
export declare function deriveProvisionalTitle(rawPrompt: string | null | undefined): string | null;
/** Generate on the first prompt, then only for substantial later prompts. */
export declare function shouldGenerateConversationTitle(prompt: string, userPromptCount: number): boolean;
export declare function generateTitle<Result extends TitleGenerationTextResult>(input: GenerateTitleInput<Result>): Promise<GenerateTitleResult<Result> | null>;
export declare function normalizeGeneratedTitle(text: string): string | null;
export {};
