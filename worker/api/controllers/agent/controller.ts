import { WebSocketMessageResponses } from '../../../agents/constants';
import { BaseController } from '../baseController';
import { generateId } from '../../../utils/idGenerator';
import { CodeGenState } from '../../../agents/core/state';
import { getAgentStub, getTemplateForQuery } from '../../../agents';
import { AgentConnectionData, AgentPreviewResponse, CodeGenArgs } from './types';
import { ApiResponse, ControllerResponse } from '../types';
import { RouteContext } from '../../types/route-context';
import { ModelConfigService } from '../../../database';
import { ModelConfig } from '../../../agents/inferutils/config.types';
import { RateLimitService } from '../../../services/rate-limit/rateLimits';
import { validateWebSocketOrigin } from '../../../middleware/security/websocket';
import { createLogger } from '../../../logger';
import { getPreviewDomain } from 'worker/utils/urls';

const defaultCodeGenArgs: CodeGenArgs = {
    query: '',
    language: 'typescript',
    frameworks: ['react', 'vite'],
    selectedTemplate: 'auto',
    agentMode: 'deterministic',
};


/**
 * CodingAgentController to handle all code generation related endpoints
 */
export class CodingAgentController extends BaseController {
    static logger = createLogger('CodingAgentController');
    /**
     * Start the incremental code generation process
     */
    static async startCodeGeneration(request: Request, env: Env, _: ExecutionContext, context: RouteContext): Promise<Response> {
        try {
            this.logger.info('Starting code generation process');

            const url = new URL(request.url);
            const hostname = url.hostname === 'localhost' ? `localhost:${url.port}`: getPreviewDomain(env);
            // Parse the query from the request body
            let body: CodeGenArgs;
            try {
                body = await request.json() as CodeGenArgs;
            } catch (error) {
                return CodingAgentController.createErrorResponse(`Invalid JSON in request body: ${JSON.stringify(error, null, 2)}`, 400);
            }

            const query = body.query;
            if (!query) {
                return CodingAgentController.createErrorResponse('Missing "query" field in request body', 400);
            }
            const { readable, writable } = new TransformStream({
                transform(chunk, controller) {
                    if (chunk === "terminate") {
                        controller.terminate();
                    } else {
                        const encoded = new TextEncoder().encode(JSON.stringify(chunk) + '\n');
                        controller.enqueue(encoded);
                    }
                }
            });
            const writer = writable.getWriter();
            // Check if user is authenticated (required for app creation)
            const user = context.user!;
            try {
                await RateLimitService.enforceAppCreationRateLimit(env, context.config.security.rateLimit, user, request);
            } catch (error) {
                if (error instanceof Error) {
                    return CodingAgentController.createErrorResponse(error, 429);
                } else {
                    this.logger.error('Unknown error in enforceAppCreationRateLimit', error);
                    return CodingAgentController.createErrorResponse(JSON.stringify(error), 429);
                }
            }

            const agentId = generateId();
            const modelConfigService = new ModelConfigService(env);
                                
            // Fetch all user model configs, api keys and agent instance at once
            const [userConfigsRecord, agentInstance] = await Promise.all([
                modelConfigService.getUserModelConfigs(user.id),
                getAgentStub(env, agentId, false, this.logger)
            ]);
                                
            // Convert Record to Map and extract only ModelConfig properties
            const userModelConfigs = new Map();
            for (const [actionKey, mergedConfig] of Object.entries(userConfigsRecord)) {
                if (mergedConfig.isUserOverride) {
                    const modelConfig: ModelConfig = {
                        name: mergedConfig.name,
                        max_tokens: mergedConfig.max_tokens,
                        temperature: mergedConfig.temperature,
                        reasoning_effort: mergedConfig.reasoning_effort,
                        fallbackModel: mergedConfig.fallbackModel
                    };
                    userModelConfigs.set(actionKey, modelConfig);
                }
            }

            const inferenceContext = {
                userModelConfigs: Object.fromEntries(userModelConfigs),
                agentId: agentId,
                userId: user.id,
                enableRealtimeCodeFix: true, // For now disabled from the model configs itself
            }
                                
            this.logger.info(`Initialized inference context for user ${user.id}`, {
                modelConfigsCount: Object.keys(userModelConfigs).length,
            });

            const { sandboxSessionId, templateDetails, selection } = await getTemplateForQuery(env, inferenceContext, query, this.logger);

            const websocketUrl = `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}/api/agent/${agentId}/ws`;
            const httpStatusUrl = `${url.origin}/api/agent/${agentId}`;
        
            writer.write({
                message: 'Code generation started',
                agentId: agentId,
                websocketUrl,
                httpStatusUrl,
                template: {
                    name: templateDetails.name,
                    files: templateDetails.files,
                }
            });

            const agentPromise = agentInstance.initialize({
                query,
                language: body.language || defaultCodeGenArgs.language,
                frameworks: body.frameworks || defaultCodeGenArgs.frameworks,
                hostname,
                inferenceContext,
                onBlueprintChunk: (chunk: string) => {
                    writer.write({chunk});
                },
                templateInfo: { templateDetails, selection },
                sandboxSessionId
            }, body.agentMode || defaultCodeGenArgs.agentMode) as Promise<CodeGenState>;
            agentPromise.then(async (_state: CodeGenState) => {
                writer.write("terminate");
                writer.close();
                this.logger.info(`Agent ${agentId} terminated successfully`);
            });

            this.logger.info(`Agent ${agentId} init launched successfully`);
            
            return new Response(readable, {
                status: 200,
                headers: {
                    // Use SSE content-type to ensure Cloudflare disables buffering,
                    // while the payload remains NDJSON lines consumed by the client.
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    // Prevent intermediary caches/proxies from buffering or transforming
                    'Cache-Control': 'no-cache, no-store, must-revalidate, no-transform',
                    'Pragma': 'no-cache',
                    'Connection': 'keep-alive'
                }
            });
        } catch (error) {
            this.logger.error('Error starting code generation', error);
            return CodingAgentController.handleError(error, 'start code generation');
        }
    }

    /**
     * Handle WebSocket connections for code generation
     * This routes the WebSocket connection directly to the Agent
     */
    static async handleWebSocketConnection(
        request: Request,
        env: Env,
        _: ExecutionContext,
        context: RouteContext
    ): Promise<Response> {
        try {
            const chatId = context.pathParams.agentId; // URL param is still agentId for backward compatibility
            if (!chatId) {
                return CodingAgentController.createErrorResponse('Missing agent ID parameter', 400);
            }

            // Ensure the request is a WebSocket upgrade request
            if (request.headers.get('Upgrade') !== 'websocket') {
                return new Response('Expected WebSocket upgrade', { status: 426 });
            }
            
            // Validate WebSocket origin
            if (!validateWebSocketOrigin(request, env)) {
                return new Response('Forbidden: Invalid origin', { status: 403 });
            }

            // Extract user for rate limiting
            const user = context.user!;
            if (!user) {
                return CodingAgentController.createErrorResponse('Missing user', 401);
            }

            this.logger.info(`WebSocket connection request for chat: ${chatId}`);
            
            // Log request details for debugging
            const headers: Record<string, string> = {};
            request.headers.forEach((value, key) => {
                headers[key] = value;
            });
            this.logger.info('WebSocket request details', {
                headers,
                url: request.url,
                chatId
            });

            try {
                // Get the agent instance to handle the WebSocket connection
                const agentInstance = await getAgentStub(env, chatId, true, this.logger);
                
                this.logger.info(`Successfully got agent instance for chat: ${chatId}`);

                // Let the agent handle the WebSocket connection directly
                return agentInstance.fetch(request);
            } catch (error) {
                this.logger.error(`Failed to get agent instance with ID ${chatId}:`, error);
                // Return an appropriate WebSocket error response
                // We need to emulate a WebSocket response even for errors
                const { 0: client, 1: server } = new WebSocketPair();

                server.accept();
                server.send(JSON.stringify({
                    type: WebSocketMessageResponses.ERROR,
                    error: `Failed to get agent instance: ${error instanceof Error ? error.message : String(error)}`
                }));

                server.close(1011, 'Agent instance not found');

                return new Response(null, {
                    status: 101,
                    webSocket: client
                });
            }
        } catch (error) {
            this.logger.error('Error handling WebSocket connection', error);
            return CodingAgentController.handleError(error, 'handle WebSocket connection');
        }
    }

    /**
     * Connect to an existing agent instance
     * Returns connection information for an already created agent
     */
    static async connectToExistingAgent(
        request: Request,
        env: Env,
        _: ExecutionContext,
        context: RouteContext
    ): Promise<ControllerResponse<ApiResponse<AgentConnectionData>>> {
        try {
            const agentId = context.pathParams.agentId;
            if (!agentId) {
                return CodingAgentController.createErrorResponse<AgentConnectionData>('Missing agent ID parameter', 400);
            }

            this.logger.info(`Connecting to existing agent: ${agentId}`);

            try {
                // Verify the agent instance exists
                const agentInstance = await getAgentStub(env, agentId, true, this.logger);
                if (!agentInstance || !(await agentInstance.isInitialized())) {
                    return CodingAgentController.createErrorResponse<AgentConnectionData>('Agent instance not found or not initialized', 404);
                }
                this.logger.info(`Successfully connected to existing agent: ${agentId}`);

                // Construct WebSocket URL
                const url = new URL(request.url);
                const websocketUrl = `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}/api/agent/${agentId}/ws`;

                const responseData: AgentConnectionData = {
                    websocketUrl,
                    agentId,
                };

                return CodingAgentController.createSuccessResponse(responseData);
            } catch (error) {
                this.logger.error(`Failed to connect to agent ${agentId}:`, error);
                return CodingAgentController.createErrorResponse<AgentConnectionData>(`Agent instance not found or unavailable: ${error instanceof Error ? error.message : String(error)}`, 404);
            }
        } catch (error) {
            this.logger.error('Error connecting to existing agent', error);
            return CodingAgentController.handleError(error, 'connect to existing agent') as ControllerResponse<ApiResponse<AgentConnectionData>>;
        }
    }

    static async deployPreview(
        _request: Request,
        env: Env,
        _: ExecutionContext,
        context: RouteContext
    ): Promise<ControllerResponse<ApiResponse<AgentPreviewResponse>>> {
        try {
            const agentId = context.pathParams.agentId;
            if (!agentId) {
                return CodingAgentController.createErrorResponse<AgentPreviewResponse>('Missing agent ID parameter', 400);
            }

            this.logger.info(`Deploying preview for agent: ${agentId}`);

            try {
                // Get the agent instance
                const agentInstance = await getAgentStub(env, agentId, true, this.logger);
                
                // Deploy the preview
                const preview = await agentInstance.deployToSandbox();
                if (!preview) {
                    return CodingAgentController.createErrorResponse<AgentPreviewResponse>('Failed to deploy preview', 500);
                }
                this.logger.info('Preview deployed successfully', {
                    agentId,
                    previewUrl: preview.previewURL
                });

                return CodingAgentController.createSuccessResponse(preview);
            } catch (error) {
                this.logger.error('Failed to deploy preview', { agentId, error });
                return CodingAgentController.createErrorResponse<AgentPreviewResponse>('Failed to deploy preview', 500);
            }
        } catch (error) {
            this.logger.error('Error deploying preview', error);
            const appError = CodingAgentController.handleError(error, 'deploy preview') as ControllerResponse<ApiResponse<AgentPreviewResponse>>;
            return appError;
        }
    }
}