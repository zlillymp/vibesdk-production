import { RuntimeError, RuntimeErrorSchema, StaticAnalysisResponse, TemplateDetails, TemplateFileSchema } from "../services/sandbox/sandboxTypes";
import { TemplateRegistry } from "./inferutils/schemaFormatters";
import z from 'zod';
import { Blueprint, BlueprintSchema, ClientReportedErrorSchema, ClientReportedErrorType, FileOutputType, PhaseConceptSchema, PhaseConceptType, TemplateSelection } from "./schemas";
import { IssueReport } from "./domain/values/IssueReport";
import { SCOFFormat } from "./streaming-formats/scof";
import { MAX_PHASES } from "./core/state";

export const PROMPT_UTILS = {
    /**
     * Replace template variables in a prompt string
     * @param template The template string with {{variable}} placeholders
     * @param variables Object with variable name -> value mappings
     */
    replaceTemplateVariables(template: string, variables: Record<string, string>): string {
        let result = template;
        
        for (const [key, value] of Object.entries(variables)) {
            const placeholder = `{{${key}}}`;
            result = result.replaceAll(placeholder, value ?? '');
        }
        
        return result;
    },

    serializeTemplate(template?: TemplateDetails, forCodegen: boolean = true): string {
        if (template) {
            // const filesText = JSON.stringify(tpl.files, null, 2);
            const filesText = TemplateRegistry.markdown.serialize(
                { files: template.files.filter(f => !f.filePath.includes('package.json')) },
                z.object({ files: z.array(TemplateFileSchema) })
            );
            // const indentedFilesText = filesText.replace(/^(?=.)/gm, '\t\t\t\t'); // Indent each line with 4 spaces
            return `
<TEMPLATE DETAILS>
The following are the details (structures and files) of the starting boilerplate template, on which the project is based.

Name: ${template.name}
Frameworks: ${template.frameworks?.join(', ')}

${forCodegen ? `` : `
<TEMPLATE_CORE_FILES>
**SHADCN COMPONENTS, Error boundary components and use-toast hook ARE PRESENT AND INSTALLED BUT EXCLUDED FROM THESE FILES DUE TO CONTEXT SPAM**
${filesText}
</TEMPLATE_CORE_FILES>`}

<TEMPLATE_FILE_TREE>
**Use these files as a reference for the file structure, components and hooks that are present**
${JSON.stringify(template.fileTree, null, 2)}
</TEMPLATE_FILE_TREE>

Apart from these files, All SHADCN Components are present in ./src/components/ui/* and can be imported from there, example: import { Button } from "@/components/ui/button";
**Please do not rewrite these components, just import them and use them**

Template Usage Instructions: 
${template.description.usage}

<DO NOT TOUCH FILES>
These files are forbidden to be modified. Do not touch them under any circumstances.
${template.dontTouchFiles.join('\n')}
</DO NOT TOUCH FILES>

<REDACTED FILES>
These files are redacted. They exist but their contents are hidden for security reasons. Do not touch them under any circumstances.
${template.redactedFiles.join('\n')}
</REDACTED FILES>

**Websockets and dynamic imports are not supported, so please avoid using them.**

</TEMPLATE DETAILS>`;
        } else {
            return `
<START_FROM_SCRATCH>
No starter template is available—design the entire structure yourself. You need to write all the configuration files, package.json, and all the source code files from scratch.
You are allowed to install stuff. Be very careful with the versions of libraries and frameworks you choose.
For an example typescript vite project,
The project should support the following commands in package.json to run the application:
"scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "lint": "eslint .",
    "preview": "npm run build && vite preview",
    "deploy": "npm run build && wrangler deploy",
    "cf-typegen": "wrangler types"
}
and provide a preview url for the application.

</START_FROM_SCRATCH>`;
        }
    },

    serializeErrors(errors: RuntimeError[]): string {
        if (errors && errors.length > 0) {
            const errorsSerialized = errors.map(e => {
                // Use rawOutput if available, otherwise serialize using schema
                const errorText = e.rawOutput || TemplateRegistry.markdown.serialize(e, RuntimeErrorSchema);
                // Truncate to 1000 characters to prevent context overflow
                return errorText.slice(0, 1000);
            });
            return errorsSerialized.join('\n\n');
        } else {
            return 'N/A';
        }
    },

    serializeStaticAnalysis(staticAnalysis: StaticAnalysisResponse): string {
        const lintOutput = staticAnalysis.lint?.rawOutput || 'No linting issues detected';
        const typecheckOutput = staticAnalysis.typecheck?.rawOutput || 'No type checking issues detected';
        
        return `**LINT ANALYSIS:**
${lintOutput}

**TYPE CHECK ANALYSIS:**
${typecheckOutput}`;
    },

    serializeClientReportedErrors(errors: ClientReportedErrorType[]): string {
        if (errors && errors.length > 0) {
            const errorsText = TemplateRegistry.markdown.serialize(
                { errors },
                z.object({ errors: z.array(ClientReportedErrorSchema) })
            );
            return errorsText;
        } else {
            return 'No client-reported errors';
        }
    },

    verifyPrompt(prompt: string): string {
        // If any of the '{{variables}}' are not replaced, throw an error
        // if (prompt.includes('{{')) {
        //     throw new Error(`Prompt contains un-replaced variables: ${prompt}`);
        // }
        return prompt;
    },

    serializeFiles(files: FileOutputType[]): string {
        // TemplateRegistry.markdown.serialize({ files: files }, z.object({ files: z.array(FileOutputSchema) }))
        // return files.map(file => {
        //     return `File: ${file.filePath}\nPurpose: ${file.filePurpose}\nContents: ${file.fileContents}`;
        // }).join('\n');
        // Use scof format
        return new SCOFFormat().serialize(files.map(file => {
            return {
                ...file,
                format: 'full_content'
            }
        }));
    },

    REACT_RENDER_LOOP_PREVENTION: `<REACT_RENDER_LOOP_PREVENTION>
In React, "Maximum update depth exceeded" means something in your component tree is setting state in a way that immediately triggers another render, which sets state again… and you've created a render→setState→render loop. React aborts after ~50 nested updates and throws this error.

## The 3 Root Causes of Infinite Loops

### 1. **Direct State Updates During Render (MOST COMMON)**
Never call a state setter directly within the rendering logic of your component. All state updates must happen in event handlers, useEffect hooks, or async callbacks.

**Basic Pattern:**
\`\`\`tsx
// BAD CODE ❌ State update during render
function Bad() {
    const [n, setN] = useState(0);
    setN(n + 1); // Runs on every render -> infinite loop
    return <div>{n}</div>;
}

// GOOD CODE ✅ State update in event handler
function Good() {
    const [n, setN] = useState(0);
    const handleClick = () => setN(n + 1); // Safe: only runs on user interaction
    return <button onClick={handleClick}>{n}</button>;
}
\`\`\`

**Conditional Updates During Render:**
\`\`\`tsx
// BAD CODE ❌ Conditional state update in render
function Component({ showModal }) {
    const [modalOpen, setModalOpen] = useState(false);
    if (showModal && !modalOpen) {
        setModalOpen(true); // setState during render
    }
    return modalOpen ? <Modal /> : null;
}

// GOOD CODE ✅ Use useEffect for state synchronization
function Component({ showModal }) {
    const [modalOpen, setModalOpen] = useState(false);
    useEffect(() => {
        setModalOpen(showModal);
    }, [showModal]);
    return modalOpen ? <Modal /> : null;
}
\`\`\`

**Side Effects in Memoization:**
\`\`\`tsx
// BAD CODE ❌ State update inside useMemo/useCallback
function Component({ data }) {
    const [processed, setProcessed] = useState(null);
    const memoizedValue = useMemo(() => {
        setProcessed(data.map(transform)); // Side effect in memoization
        return computedValue;
    }, [data]);
    return <div>{memoizedValue}</div>;
}

// GOOD CODE ✅ Separate side effects from memoization
function Component({ data }) {
    const [processed, setProcessed] = useState(null);
    const memoizedValue = useMemo(() => computedValue, [data]);
    
    useEffect(() => {
        setProcessed(data.map(transform));
    }, [data]);
    
    return <div>{memoizedValue}</div>;
}
\`\`\`

### 2. **Effects Triggering Themselves Unconditionally**
An effect that sets state must have logic to prevent it from running again after that state is set.

**Missing Dependency Array:**
\`\`\`tsx
// BAD CODE ❌ Effect runs after every render
function BadCounter() {
    const [count, setCount] = useState(0);
    useEffect(() => {
        setCount(prevCount => prevCount + 1);
    }); // No dependency array -> infinite loop
    return <div>{count}</div>;
}

// GOOD CODE ✅ Dependency array prevents infinite loop
function GoodCounter() {
    const [count, setCount] = useState(0);
    useEffect(() => {
        setCount(1); // Only run once on mount
    }, []); // Empty array = run once on mount
    return <div>{count}</div>;
}
\`\`\`

**Conditional Effect Logic:**
\`\`\`tsx
// GOOD CODE ✅ Effect with conditional logic
function UserData({ userId }) {
    const [user, setUser] = useState(null);
    useEffect(() => {
        if (userId) { // Conditional logic prevents unnecessary runs
            fetchUser(userId).then(data => setUser(data));
        }
    }, [userId]); // Only runs when userId changes
    return <div>{user ? user.name : 'Loading...'}</div>;
}
\`\`\`

### 3. **Unstable Dependencies (Referential Inequality)**
When a dependency for useEffect, useMemo, or useCallback is a non-primitive (object, array, function) that is re-created on every render.

**Objects in useEffect:**
\`\`\`tsx
// BAD CODE ❌ Object dependency is recreated every render
function Component() {
    const [v, setV] = useState(0);
    const filters = { type: 'active', status: 'pending' }; // New object every render
    useEffect(() => {
        setV(prev => prev + 1);
    }, [filters]); // Triggers every render due to new object reference
    return <div>{v}</div>;
}

// GOOD CODE ✅ Stabilize object with useMemo
function Component() {
    const [v, setV] = useState(0);
    const filters = useMemo(() => ({ type: 'active', status: 'pending' }), []);
    useEffect(() => {
        setV(prev => prev + 1);
    }, [filters]); // Only triggers when filters actually change
    return <div>{v}</div>;
}
\`\`\`

**Context Value Recreation:**
\`\`\`tsx
// BAD CODE ❌ Context value recreated every render
function App() {
    const [user, setUser] = useState(null);
    const value = { user, setUser }; // New object every render
    return <UserContext.Provider value={value}>...</UserContext.Provider>;
}

// GOOD CODE ✅ Memoize context value
function App() {
    const [user, setUser] = useState(null);
    const value = useMemo(() => ({ user, setUser }), [user]);
    return <UserContext.Provider value={value}>...</UserContext.Provider>;
}
\`\`\`

**State Management Library Selectors:**
Never use object literals to select multiple values from a store. Always select individual values.
\`\`\`tsx
// BAD CODE ❌ Multiple values in selector: Selector returns new object every render
const { score, bestScore } = useGameStore((state) => ({
    score: state.score,
    bestScore: state.bestScore,
})); // Creates new object reference every time

// GOOD CODE ✅ Select primitive values individually
const score = useGameStore((state) => state.score);
const bestScore = useGameStore((state) => state.bestScore);
\`\`\`

**STRICT POLICY:** Do NOT destructure multiple values from an object-literal selector. Always call useStore multiple times for primitives.
\`\`\`tsx
// BAD CODE ❌ Object-literal selector with destructuring (causes unstable references)
const { servers, selectedServerId, selectedChannelId, selectChannel } = useAppStore((state) => ({
  servers: state.servers,
  selectedServerId: state.selectedServerId,
  selectedChannelId: state.selectedChannelId,
  selectChannel: state.selectChannel,
}));

// GOOD CODE ✅ Select slices individually to keep snapshots stable
const servers = useAppStore((state) => state.servers);
const selectedServerId = useAppStore((state) => state.selectedServerId);
const selectedChannelId = useAppStore((state) => state.selectedChannelId);
const selectChannel = useAppStore((state) => state.selectChannel);
\`\`\`

## Other Common Loop-Inducing Patterns

**Parent/Child Feedback Loops:**
- Child effect updates parent state → parent rerenders → child gets new props → child effect runs again
- **Solution:** Lift state up or use callbacks that are idempotent/guarded

**State within Recursive Components:**
\`\`\`tsx
// BAD CODE ❌ Each recursive call creates independent state
function FolderTree({ folders }) {
    const [expanded, setExpanded] = useState(new Set());
    return (
        <div>
            {folders.map(f => (
                <FolderTree key={f.id} folders={f.children} />
            ))}
        </div>
    );
}

// GOOD CODE ✅ Lift state up to non-recursive parent
function FolderTree({ folders, expanded, onToggle }) {
    return (
        <div>
            {folders.map(f => (
                <FolderTree key={f.id} folders={f.children} expanded={expanded} onToggle={onToggle} />
            ))}
        </div>
    );
}

function Sidebar() {
    const [expanded, setExpanded] = useState(new Set());
    const handleToggle = (id) => { /* logic */ };
    return <FolderTree folders={allFolders} expanded={expanded} onToggle={handleToggle} />;
}
\`\`\`

**Stale Closures (Correctness Issue):**
While not directly causing infinite loops, stale closures cause incorrect state transitions:
\`\`\`tsx
// BAD CODE ❌ Stale closure in event handler
function Counter() {
    const [count, setCount] = useState(0);
    const handleClick = () => {
        setCount(count + 1); // Uses stale count value
        setCount(count + 1); // Won't increment by 2
    };
    return <button onClick={handleClick}>{count}</button>;
}

// GOOD CODE ✅ Functional updates avoid stale closures
function Counter() {
    const [count, setCount] = useState(0);
    const handleClick = useCallback(() => {
        setCount(prev => prev + 1);
        setCount(prev => prev + 1); // Will correctly increment by 2
    }, []);
    return <button onClick={handleClick}>{count}</button>;
}
\`\`\`

## Quick Prevention Checklist: The Golden Rules

✅ **Move state updates out of render body** - Only update state in useEffect hooks or event handlers  
✅ **Provide dependency arrays to every useEffect** - Missing dependencies cause infinite loops  
✅ **Make effect logic conditional** - Add guards like \`if (data.length > 0)\` to prevent re-triggering  
✅ **Stabilize non-primitive dependencies** - Use useMemo and useCallback for objects/arrays/functions  
✅ **Select primitives from stores** - \`useStore(s => s.score)\` not \`useStore(s => ({ score: s.score }))\`  
✅ **Lift state up from recursive components** - Never initialize state inside recursive calls  
✅ **Use functional updates** - \`setState(prev => prev + 1)\` avoids stale closures  
✅ **Prefer refs for non-UI data** - \`useRef\` doesn't trigger re-renders when updated  
✅ **Avoid prop→state mirrors** - Derive values directly or use proper synchronization  
✅ **Break parent↔child feedback loops** - Lift state or use idempotent callbacks

\`\`\`tsx
// GOLDEN RULE EXAMPLES ✅

// 1. State updates in event handlers only
const handleClick = () => setState(newValue);

// 2. Effects with dependency arrays
useEffect(() => { /* logic */ }, [dependency]);

// 3. Conditional effect logic
useEffect(() => {
  if (userId) { fetchUser(userId).then(setUser); }
}, [userId]);

// 4. Stabilized objects/arrays
const config = useMemo(() => ({ a, b }), [a, b]);
const handleClick = useCallback(() => {}, [dep]);

// 5. Primitive selectors
const score = useStore(state => state.score);
const name = useStore(state => state.user.name);

// 6. Functional updates
setCount(prev => prev + 1);
setItems(prev => [...prev, newItem]);

// 7. Refs for non-UI data
const latestValue = useRef();
latestValue.current = currentValue; // No re-render

// 8. Derive instead of mirror
const derivedValue = propValue.toUpperCase(); // No state needed
\`\`\`
</REACT_RENDER_LOOP_PREVENTION>`,

COMMON_PITFALLS: `<AVOID COMMON PITFALLS>
    **TOP 6 MISSION-CRITICAL RULES (FAILURE WILL CRASH THE APP):**
    1. **DEPENDENCY VALIDATION:** BEFORE writing any import statement, verify it exists in <DEPENDENCIES>. Common failures: @xyflow/react uses { ReactFlow } not default import, @/lib/utils for cn function. If unsure, check the dependency list first.
    2. **IMPORT & EXPORT INTEGRITY:** Ensure every component, function, or variable is correctly defined and imported properly (and exported properly). Mismatched default/named imports will cause crashes.
    3. **NO RUNTIME ERRORS:** Write robust, fault-tolerant code. Handle all edge cases gracefully with fallbacks. Never throw uncaught errors that can crash the application.
    4. **NO UNDEFINED VALUES/PROPERTIES/FUNCTIONS/COMPONENTS etc:** Ensure all variables, functions, and components are defined before use. Never use undefined values. If you use something that isn't already defined, you need to define it.
    5. **STATE UPDATE INTEGRITY:** Never call state setters directly during the render phase; all state updates must originate from event handlers or useEffect hooks to prevent infinite loops.
    6. **STATE SELECTOR STABILITY:** When using state management libraries (Zustand, Redux), always select primitive values individually. Never return a new object or array from a single selector, as this creates unstable references and will cause infinite render loops.
    
    **UI/UX EXCELLENCE CRITICAL RULES:**
    7. **VISUAL HIERARCHY CLARITY:** Every interface must have clear visual hierarchy - never create pages with uniform text sizes or equal visual weight for all elements
    8. **INTERACTIVE FEEDBACK MANDATORY:** Every button, link, and interactive element MUST have visible hover, focus, and active states - no exceptions
    9. **RESPONSIVE BREAKPOINT INTEGRITY:** Test layouts mentally at sm, md, lg breakpoints - never create layouts that break or look unintentional at any screen size
    10. **SPACING CONSISTENCY:** Use systematic spacing (space-y-4, space-y-6, space-y-8) - avoid arbitrary margins that create visual chaos
    11. **LOADING STATE EXCELLENCE:** Every async operation must have beautiful loading states - never leave users staring at blank screens
    12. **ERROR HANDLING GRACE:** All error states must be user-friendly with clear next steps - never show raw error messages or technical jargon

    **ENHANCED RELIABILITY PATTERNS:**
    •   **State Management:** Handle loading/success/error states for async operations. Initialize state with proper defaults, never undefined. Use functional updates for dependent state.
    •   **Type Safety:** Define interfaces for props/state/API responses. Check null/undefined before property access. Validate array length before element access. Rely on \`?\` operator for properties that might be undefined.
    •   **Component Safety:** Use error boundaries for components that might fail. Provide fallbacks for conditional content. Use stable, unique keys for lists.
    •   **Performance:** Use React.memo, useMemo, useCallback to prevent unnecessary re-renders. Define event handlers outside render or use useCallback.
    •   **Object Literals**: NEVER duplicate property names. \`{name: "A", age: 25, name: "B"}\` = compilation error
    •   **Always follow best coding practices**: Follow best coding practices and principles:
        - Always maximize code reuse and minimize code redundancy and duplicacy. 
        - Strict DRY (Don't Repeat Yourself) principle.
        - Always try to import or extend existing types, components, functions, variables, etc. instead of redefining something similar.

    •   **When using Zustand with Zustand's immer middleware, never define computed getters on the store. Export typed selectors/hooks that derive from primitive IDs.**
    •   **Use useStore(selector) with functions that depend on raw state fields (e.g., IDs), not on derived getters.**
    •   **Keep actions responsible for side-effects (fetch/poll), and selectors responsible for derivation only.**
    •   **STRICT Zustand Selector Policy (ZERO TOLERANCE):** Do NOT return objects/arrays from \`useStore\` selectors nor destructure multiple values from an object-literal selector. Always select primitives individually. If you need multiple values, call \`useStore\` multiple times.
    •   If you absolutely must read multiple values in one call, pass zustand's shallow comparator: \`useStore(selector, shallow)\`. Avoid object literals and avoid \`useStore(s => s)\`.

    **ALGORITHMIC PRECISION & LOGICAL REASONING:**
    •   **Mathematical Accuracy:** For games/calculations, implement precise algorithms step-by-step. ALWAYS validate boundaries: if (x >= 0 && x < width && y >= 0 && y < height). Use === for exact comparisons.
    •   **Game Logic Systems:** Break complex logic into smaller, testable functions. Example: moveLeft(), checkWin(), updateScore(). Each function should handle ONE responsibility.
    •   **Array/Grid Operations:** CRITICAL - Check array bounds before access: if (grid[row] && grid[row][col] !== undefined). Use descriptive names: rowIndex, colIndex, not i, j.
    •   **State Transitions:** For complex state changes, use pure functions that return new state. Example: const newState = {...oldState, score: oldState.score + points}.
    •   **Algorithm Test Cases:** BEFORE coding, write a simple test case. Example: "moveLeft([2,2,4,0]) should return [4,4,0,0]". Verify your logic matches this expected output.

    **FRAMEWORK & SYNTAX SPECIFICS:**
    •   Framework compatibility: Pay attention to version differences (Tailwind v3 vs v4, React Router versions)
    •   No environment variables: App deploys serverless - avoid libraries requiring env vars unless they support defaults
    •   Next.js best practices: Follow latest patterns to prevent dev server rendering issues
    •   Tailwind classes: Verify all classes exist in tailwind.config.js (e.g., avoid undefined classes like \`border-border\`)
    •   Component exports: Export all components properly, avoid mixing default/named imports
    •   UI spacing: Ensure proper padding/margins, avoid left-aligned layouts without proper spacing

    **PROPER IMPORTS**:
       - **Importing React and other libraries should be done correctly.**

    **CRITICAL SYNTAX ERRORS - PREVENT AT ALL COSTS:**
    1. **IMPORT SYNTAX**: Always use correct import syntax. NEVER write \`import */styles/globals.css'\` - use \`import './styles/globals.css'\`
    2. **UNDEFINED VARIABLES**: Always import/define variables before use. \`cn is not defined\` = missing \`import { cn } from './lib/utils'\`

    **CRITICAL ERROR RECOVERY PATTERNS:**
    •   **API Call Safety:** Always wrap in try-catch with user-friendly fallbacks:
        \`const [data, setData] = useState(null); const [loading, setLoading] = useState(true); const [error, setError] = useState(null);\`
    •   **Component Rendering Safety:** Use conditional rendering to prevent crashes:
        \`{user ? <Profile user={user} /> : <div>Loading user...</div>}\`
    •   **Array Operations Safety:** Always check if array exists:
        \`{items?.length > 0 ? items.map(...) : <div>No items found</div>}\`
    •   **State Update Safety:** Use functional updates when depending on previous state:
        \`setCount(prev => prev + 1)\` instead of \`setCount(count + 1)\`

    **PRE-CODE VALIDATION CHECKLIST:**
    Before writing any code, mentally verify:
    - All imports use correct syntax and paths. Be cautious about named vs default imports wherever needed.
    - All variables are defined before use  
    - No setState calls during render phase
    - No object-literal selectors in Zustand (avoid \`useStore((state) => ({ ... }))\`; select primitives individually)
    - All Tailwind classes exist in config
    - External dependencies are available
    - Error boundaries around components that might fail

    **Also there is no support for websockets and dynamic imports may not work, so please avoid using them.**

    ### **IMPORT VALIDATION EXAMPLES**
    **CRITICAL**: Verify ALL imports before using. Wrong imports = runtime crashes.

    **BAD IMPORTS** (cause runtime errors):
    \`\`\`tsx
    import ReactFlow from '@xyflow/react';      // WRONG: ReactFlow is named export
    import cn from '@/lib/utils';               // WRONG: cn is named export  
    import { Button } from 'shadcn/ui';         // WRONG: should be @/components/ui
    import { useState } from 'react';           // MISSING: React itself
    import { useRouter } from 'next/navigation'; // WRONG: use 'react-router-dom'
    \`\`\`

    **GOOD IMPORTS** (correct syntax):
    \`\`\`tsx
    import React, { useState, useEffect } from 'react';  // ALWAYS import React
    import { ReactFlow } from '@xyflow/react';           // CORRECT: named export
    import { cn } from '@/lib/utils';                    // CORRECT: named export
    import { Button } from '@/components/ui/button';     // CORRECT: full path
    import { useNavigate } from 'react-router-dom';      // CORRECT for routing
    \`\`\`

    **Import Checklist**:
    - ✅ React imported in every TSX/JSX file
    - ✅ All @xyflow imports use named exports: { ReactFlow, Node, Edge }
    - ✅ All UI components use full @/components/ui/[component] path
    - ✅ cn function from '@/lib/utils' (named export)
    - ✅ Router hooks from 'react-router-dom' (not Next.js)

    **A \`require()\` or \`import()\` style import is forbidden. Always import properly at the top of the file.**
    # Few more heuristics:
        **IF** you receive a TypeScript error "cannot be used as a JSX component" for a component \`<MyComponent />\`, **AND** the error says its type is \`'typeof import(...)'\`, then check if the import is correct (named vs default import).
        Applying this rule to your situation will fix both the type-check errors and the browser's runtime error.

    # Never write image files! Never write jpeg, png, svg, etc files yourself! Always use some image url from the web.

</AVOID COMMON PITFALLS>`,
    STYLE_GUIDE: `<STYLE_GUIDE>
    • Use 2 spaces for indentation
    • Use single quotes for strings
    • Use double quotes for JSX attributes
    • Use semicolons for statements
    • **Always use named exports and imports**
</STYLE_GUIDE>
`,
    COMMON_DEP_DOCUMENTATION: `<COMMON DEPENDENCY DOCUMENTATION>
    • **The @xyflow/react package doesn't export a default ReactFlow, it exports named imports.**
        - Don't import like this:
        \`import ReactFlow from '@xyflow/react';\`
        Doing this would cause a runtime error and the only hint you would get is a lint message: 'ReactFlow' cannot be used as a JSX component. Its type 'typeof import(...)' is not a valid JSX element type

        - Import like this:
        \`import { ReactFlow } from '@xyflow/react';\`
    • **@react-three/fiber ^9.0.0 and @react-three/drei ^10.0.0 require react ^19 and will not work with react ^18.**
        - Please upgrade react to 19 to use these packages.
        - With react 18, it will throw runtime error: Cannot read properties of undefined (reading 'S')

    • **No support for websockets and dynamic imports may not work, so please avoid using them.**
</COMMON DEPENDENCY DOCUMENTATION>
`,
    COMMANDS: `<SETUP COMMANDS>
    • **Provide explicit commands to install necessary dependencies ONLY.** DO NOT SUGGEST MANUAL CHANGES. These commands execute directly.
    • **Dependency Versioning:**
        - **Use specific, known-good major versions.** Avoid relying solely on 'latest' (unless you are unsure) which can introduce unexpected breaking changes.
        - Always suggest a known recent compatible stable major version. If unsure which version might be available, don't specify any version.
        - Example: \`npm install react@18 react-dom@18\`
        - List commands to add dependencies separately, one command per dependency for clarity.
    • **Format:** Provide ONLY the raw command(s) without comments, explanations, or step numbers, in the form of a list
    • **Execution:** These run *before* code generation begins.

Example:
\`\`\`sh
bun add react@18
bun add react-dom@18
bun add zustand@4
bun add immer@9
bun add shadcn@2
bun add @geist-ui/react@1
\`\`\`
</SETUP COMMANDS>
`,
    CODE_CONTENT_FORMAT: `<CODE CONTENT GENERATION RULES> 
    The generated content for any file should be one of the following formats: \`full_content\` or \`unified_diff\`.

    - **When working on an existing (previously generated) file and the scope of changes would be smaller than a unified diff, use \`unified_diff\` format.**
    - **When writing an entirely new file, or the scope of changes would be bigger than a unified diff, use \`full_content\` format.**
    - **Do not use \`unified_diff\` for modifying untouched template files.**
    - **Make sure to choose the format so as to minimize the total length of response.**

    <RULES FOR \`full_content\`>
        • **Content Format:** Provide the complete and raw content of the file. Do not escape or wrap the content in any way.
        • **Example:**
            \`\`\`
                function myFunction() {
                    console.log('Hello, world!');
                }
            \`\`\`
    </RULES FOR \`full_content\`>

    <RULES FOR \`unified_diff\`>
        • **Content Format:** Provide the diff of the file. Do not escape or wrap the content in any way.
        • **Usage:** Use this format when working to modify an existing file and it would be smaller to represent the diff than the full content.
        
        **Diff Format Rules:**
            • Return edits similar to diffs that \`diff -U0\` would produce.
            • Do not include the first 2 lines with the file paths.
            • Start each hunk of changes with a \`@@ ... @@\` line.
            • Do not include line numbers like \`diff -U0\` does. The user's patch tool doesn't need them. The user's patch tool needs CORRECT patches that apply cleanly against the current contents of the file!
            • Think carefully and make sure you include and mark all lines that need to be removed or changed as \`-\` lines.
            • Make sure you mark all new or modified lines with \`+\`.
            • Don't leave out any lines or the diff patch won't apply correctly.
            • Indentation matters in the diffs!
            • Start a new hunk for each section of the file that needs changes.
            • Only output hunks that specify changes with \`+\` or \`-\` lines.
            • Skip any hunks that are entirely unchanging \` \` lines.
            • Output hunks in whatever order makes the most sense. Hunks don't need to be in any particular order.
            • When editing a function, method, loop, etc try to use a hunk to replace the *entire* code block. Delete the entire existing version with \`-\` lines and then add a new, updated version with \`+\` lines.  This will help you generate correct code and correct diffs.
            • To move code within a file, use 2 hunks: 1 to delete it from its current location, 1 to insert it in the new location.
        **Example:**

** Instead of low level diffs like this: **
\`\`\`
@@ ... @@
-def factorial(n):
+def factorial(number):
-    if n == 0:
+    if number == 0:
         return 1
     else:
-        return n * factorial(n-1)
+        return number * factorial(number-1)
\`\`\`

**Write high level diffs like this:**

\`\`\`
@@ ... @@
-def factorial(n):
-    if n == 0:
-        return 1
-    else:
-        return n * factorial(n-1)
+def factorial(number):
+    if number == 0:
+        return 1
+    else:
+        return number * factorial(number-1)
\`\`\`

    </RULES FOR \`unified_diff\`>

    When a changes to a file are big or the file itself is small, it is better to use \`full_content\` format, otherwise use \`unified_diff\` format. In the end, you should choose a format that minimizes the total length of response.
</CODE CONTENT GENERATION RULES>
`,
    UI_GUIDELINES: `## UI MASTERY & VISUAL EXCELLENCE STANDARDS
    
    ### 🎨 VISUAL HIERARCHY MASTERY
    • **Typography Excellence:** Create stunning text hierarchies:
        - Headlines: text-4xl/5xl/6xl with font-bold for maximum impact
        - Subheadings: text-2xl/3xl with font-semibold for clear structure  
        - Body: text-lg/base with font-medium for perfect readability
        - Captions: text-sm with font-normal for supporting details
        - **Color Psychology:** Use text-gray-900 for primary, text-gray-600 for secondary, text-gray-400 for tertiary
    • **Spacing Rhythm:** Create visual breathing room with harmonious spacing:
        - Section gaps: space-y-16 md:space-y-24 for major sections
        - Content blocks: space-y-6 md:space-y-8 for related content
        - Element spacing: space-y-3 md:space-y-4 for tight groupings
        - **Golden Ratio:** Use 8px base unit (space-2) multiplied by fibonacci numbers (1,1,2,3,5,8,13...)
    
    ### ✨ INTERACTIVE DESIGN EXCELLENCE
    • **Micro-Interactions:** Every interactive element must delight users:
        - **Hover States:** Subtle elevation (hover:shadow-lg), color shifts (hover:bg-blue-600), or scale (hover:scale-105)
        - **Focus States:** Beautiful ring outlines (focus:ring-2 focus:ring-blue-500 focus:ring-offset-2)
        - **Active States:** Pressed effects (active:scale-95) for tactile feedback
        - **Loading States:** Elegant spinners, skeleton screens, or pulse animations
        - **Transitions:** Smooth animations (transition-all duration-200 ease-in-out) for every state change
    • **Button Mastery:** Create buttons that users love to click:
        - **Primary:** Bold, vibrant colors (bg-blue-600 hover:bg-blue-700) with perfect contrast
        - **Secondary:** Subtle elegance (bg-gray-100 hover:bg-gray-200) with clear hierarchy
        - **Outline:** Clean borders (border-2 border-blue-600 text-blue-600 hover:bg-blue-600 hover:text-white)
        - **Danger:** Warning colors (bg-red-600 hover:bg-red-700) for destructive actions
    
    ### 🏗️ LAYOUT ARCHITECTURE EXCELLENCE
    • **Container Strategies:** Build layouts that feel intentional:
        - **Content Width:** Use max-w-7xl mx-auto for main containers
        - **Responsive Padding:** px-4 sm:px-6 lg:px-8 for perfect edge spacing
        - **Section Spacing:** py-16 md:py-24 lg:py-32 for generous vertical rhythm
    • **Grid Systems:** Create balanced, beautiful layouts:
        - **Product Grids:** grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 with gap-6 md:gap-8
        - **Feature Grids:** grid-cols-1 md:grid-cols-2 lg:grid-cols-3 with consistent aspect ratios
        - **Dashboard Grids:** Responsive grid-cols-12 with proper breakpoints for complex layouts
    • **Flexbox Mastery:** Perfect alignment and distribution:
        - **Navigation:** flex items-center justify-between for header layouts
        - **Cards:** flex flex-col justify-between for equal height card layouts
        - **Forms:** flex flex-col space-y-4 for clean form arrangements
    
    ### 🎯 COMPONENT DESIGN EXCELLENCE
    • **Card Components:** Design cards that stand out beautifully:
        - **Elevation:** Use shadow-sm, shadow-md, shadow-lg strategically for visual depth
        - **Borders:** Subtle border border-gray-200 or borderless with shadow for modern feel
        - **Padding:** p-6 md:p-8 for comfortable content spacing
        - **Hover Effects:** hover:shadow-xl hover:-translate-y-1 for delightful interactions
    • **Form Excellence:** Make forms a joy to use:
        - **Input States:** Beautiful focus rings, clear error states, success indicators
        - **Label Design:** font-medium text-gray-700 with proper spacing (mb-2)
        - **Error Handling:** text-red-600 text-sm with helpful, friendly messages
        - **Success Feedback:** text-green-600 with checkmark icons for validation
    • **Navigation Design:** Create intuitive, beautiful navigation:
        - **Active States:** Clear indicators with color, background, or underline
        - **Breadcrumbs:** Subtle text-gray-500 with proper separators
        - **Mobile Menu:** Smooth slide-in animations with backdrop blur
    
    ### 📱 RESPONSIVE DESIGN MASTERY
    • **Mobile-First Excellence:** Design for mobile, enhance for desktop:
        - **Touch Targets:** Minimum 44px touch targets for mobile usability
        - **Typography Scaling:** text-2xl md:text-4xl lg:text-5xl for responsive headers
        - **Image Handling:** aspect-w-16 aspect-h-9 for consistent image ratios
    • **Breakpoint Strategy:** Use Tailwind breakpoints meaningfully:
        - **sm (640px):** Tablet portrait adjustments
        - **md (768px):** Tablet landscape and small desktop
        - **lg (1024px):** Desktop layouts
        - **xl (1280px):** Large desktop enhancements
        - **2xl (1536px):** Ultra-wide optimizations
    
    ### 🌟 VISUAL POLISH CHECKLIST
    **Before completing any component, ensure:**
    - ✅ **Visual Rhythm:** Consistent spacing that creates natural reading flow
    - ✅ **Color Harmony:** Thoughtful color choices that support the brand and enhance usability
    - ✅ **Interactive Feedback:** Every clickable element responds beautifully to user interaction
    - ✅ **Loading Elegance:** Graceful loading states that maintain user engagement
    - ✅ **Error Grace:** Helpful, non-intimidating error messages with clear next steps
    - ✅ **Empty State Beauty:** Inspiring empty states that guide users toward their first success
    - ✅ **Accessibility Excellence:** Proper contrast ratios, keyboard navigation, screen reader support
    - ✅ **Performance Smooth:** 60fps animations and instant perceived load times`,
    PROJECT_CONTEXT: `Here is everything you will need for the project:

<PROJECT CONTEXT>

<COMPLETED PHASES>

The following phases have been completed and implemented:

{{phases}}

</COMPLETED PHASES>

<CODEBASE>

Here are all the relevant files in the current codebase:

{{files}}

**THESE DO NOT INCLUDE PREINSTALLED SHADCN COMPONENTS, REDACTED FOR SIMPLICITY. BUT THEY DO EXIST AND YOU CAN USE THEM.**

</CODEBASE>

{{commandsHistory}}

</PROJECT CONTEXT>
`,
}

export const STRATEGIES_UTILS = {
    INITIAL_PHASE_GUIDELINES: `**First Phase: Stunning Frontend Foundation & Visual Excellence**
        * **🎨 VISUAL DESIGN FOUNDATION:** Establish breathtaking visual foundation:
            - **Design System Excellence:** Define beautiful color palettes, typography scales, and spacing rhythms
            - **Component Library Mastery:** Leverage shadcn components to create stunning, cohesive interfaces
            - **Layout Architecture:** Build gorgeous navigation, headers, footers with perfect spacing and alignment
            - **Visual Identity:** Establish consistent branding elements that create emotional connection
        * **✨ UI COMPONENT EXCELLENCE:** Create components that users love to interact with:
            - **Interactive Polish:** Every button, form, and clickable element has beautiful hover states
            - **Micro-Interactions:** Subtle animations that provide delightful feedback
            - **State Management:** Loading, error, and empty states that maintain user engagement
            - **Responsive Mastery:** Components that look intentionally designed at every screen size
        * **🏗️ FRONTEND COMPLETION WITH VISUAL WOW FACTOR:** Build interfaces that impress:
            - **Primary Page Excellence:** Main page should be visually stunning and fully functional
            - **Secondary Page Polish:** All supporting pages with beautiful mockups and smooth navigation
            - **Zero Broken Links:** Every navigation element works perfectly - no 404s or dead ends
            - **Visual Hierarchy:** Clear information architecture that guides users naturally
            - **Content Strategy:** Thoughtful use of whitespace, typography, and visual elements
        * **🚀 CORE FUNCTIONALITY WITH STYLE:** Implement features that work beautifully:
            - **Feature Implementation:** Core application logic with elegant error handling
            - **Data Presentation:** Beautiful ways to display information that enhance comprehension
            - **User Workflows:** Smooth, intuitive user journeys with clear next steps
            - **Performance Excellence:** Fast, responsive interfaces that feel instant
        * **📱 RESPONSIVE & ACCESSIBLE EXCELLENCE:**
            - **Mobile-First Beauty:** Interfaces that shine on mobile and scale up gracefully
            - **Touch-Friendly Design:** Proper touch targets and gesture-friendly interactions
            - **Accessibility Excellence:** Beautiful interfaces that work for everyone
        * **🎯 COMPLETION STANDARDS:** Every element demonstrates professional-grade polish
            - **Visual Consistency:** Cohesive design language throughout all pages
            - **Interactive Feedback:** Every user action provides clear, beautiful feedback
            - **Error Handling Grace:** Helpful, friendly error messages that guide users forward
            - **Loading Elegance:** Beautiful loading states that maintain user engagement
        * **Phase Granularity:** For *simple* applications, deliver a complete, stunning product in one phase. For *complex* applications, establish a visually excellent foundation that impresses immediately.
        * **Deployable Milestone:** First phase should be immediately demoable with stunning visual appeal that makes stakeholders excited about the final product.
        * **Override template home page**: Be sure to rewrite the home page of the app. Do not remove the existing homepage, rewrite on top of it.`,
    SUBSEQUENT_PHASE_GUIDELINES: `**Subsequent Phases: Feature Excellence & Visual Refinement**
        * **🌟 ITERATIVE VISUAL EXCELLENCE:** Each phase elevates the user experience:
            - **Visual Polish Iteration:** Continuously refine spacing, colors, and interactions
            - **Animation Enhancement:** Add smooth transitions and delightful micro-interactions
            - **Component Refinement:** Improve existing components to professional-grade standards
            - **User Experience Optimization:** Streamline workflows and eliminate friction points
        * **🚀 FEATURE IMPLEMENTATION WITH STYLE:** Build functionality that users love:
            - **Complete Feature Development:** Every requested feature implemented with beautiful UI
            - **Workflow Optimization:** Smooth user journeys with intuitive navigation patterns
            - **Data Visualization Excellence:** Beautiful charts, tables, and information displays
            - **Interactive Feature Polish:** Forms, modals, and complex interactions that feel effortless
        * **🔗 BACKEND INTEGRATION EXCELLENCE:** Connect functionality with visual grace:
            - **Elegant Loading States:** Beautiful progress indicators and skeleton screens
            - **Error Handling Beauty:** Friendly error messages with helpful recovery actions
            - **Data State Management:** Graceful handling of empty, loading, and error states
            - **Performance Optimization:** Fast, responsive interfaces with smooth data transitions
        * **📈 SCALABLE ENHANCEMENT STRATEGY:** Build quality that scales:
            - **Component System Growth:** Expand design system with new, reusable components
            - **Pattern Library Development:** Establish consistent interaction patterns
            - **Visual Language Evolution:** Refine brand expression and visual identity
            - **User Experience Research:** Iterate based on usage patterns and feedback
        * **✨ CONTINUOUS UI/UX IMPROVEMENT:** Never settle for 'good enough':
            - **Visual Hierarchy Refinement:** Perfect information architecture and visual flow
            - **Interaction Design Polish:** Smooth, predictable, and delightful user interactions
            - **Responsive Design Excellence:** Flawless experience across all device sizes
            - **Accessibility Enhancement:** Beautiful interfaces that work for everyone
        * **🎯 CLIENT FEEDBACK INTEGRATION:** Rapid response to user needs:
            - **Priority Feature Development:** Address urgent client requests with visual excellence
            - **User Experience Optimization:** Refine workflows based on real user feedback
            - **Visual Preference Integration:** Adapt design elements to client brand preferences
            - **Performance Enhancement:** Optimize for speed while maintaining visual quality
        * **🏆 FINAL EXCELLENCE PHASE:** Deliver a product that exceeds expectations:
            - **Comprehensive Polish Review:** Every pixel perfect, every interaction smooth
            - **Performance Optimization:** Lightning-fast load times with beautiful interfaces
            - **Cross-Browser Excellence:** Perfect rendering across all modern browsers
            - **Quality Assurance:** Thorough testing of every feature and interaction
            - **Launch Readiness:** Production-ready code with comprehensive documentation`,
    CODING_GUIDELINES: `**Make sure the product is **FUNCTIONAL** along with **POLISHED**
    **MAKE SURE TO NOT BREAK THE APPLICATION in SUBSEQUENT PHASES. Always keep fallbacks and failsafes in place for any backend interactions. Look out for simple syntax errors and dependencies you use!**
    **The client needs to be provided with a good demoable application after each phase. The initial first phase is the most impressionable phase! Make sure it deploys and renders well.**
    **Make sure the primary (home) page is rendered correctly and as expected after each phase**
    **Make sure to overwrite the home page file**`,
    CONSTRAINTS: `<PHASE GENERATION CONSTRAINTS>
        **Focus on building the frontend and all the views/pages in the initial 1-2 phases with core functionality and mostly mock data, then fleshing out the application**    
        **Before writing any components of your own, make sure to check the existing components and files in the template, try to use them if possible (for example preinstalled shadcn components)**
        **If auth functionality is required, provide mock auth functionality primarily. Provide real auth functionality ONLY IF template has persistence layer. Remember to seed the persistence layer with mock data AND Always PREFILL the UI with mock credentials. No oauth needed**

        **Applications with single view/page or mostly static content are considered **Simple Projects** and those with multiple views/pages are considered **Complex Projects** and should be designed accordingly.**
        * **Phase Count:** Aim for a maximum of 1 phase for simple applications and 3-7 phases for complex applications. Each phase should be self-contained. Do not exceed more than ${Math.floor(MAX_PHASES * 0.8)} phases unless addressing complex client feedbacks.
        * **File Count:** Aim for a maximum of 1-3 files per phase for simple applications and 8-12 files per phase for complex applications.
        * The number of files in the project should be proportional to the number of views/pages that the project has.
        * Keep the size of codebase as small as possible, write encapsulated and abstracted code that can be reused, maximize code and component reuse and modularity. If a function/component is to be used in multiple files, it should be defined in a shared file.
        **DO NOT WRITE/MODIFY README FILES, LICENSES, ESSENTIAL CONFIG, OR OTHER NON-APPLICATION FILES as they are already configured in the final deployment. You are allowed to modify tailwind.config.js, vite.config.js etc if necessary**
            - Be very careful while working on vite.config.js, tailwind.config.js, etc. as any wrong changes can break the application.
        **DO NOT WRITE pdf files, images, or any other non-text files as they are not supported by the deployment.**

        **Examples**:
            * Building any tic-tac-toe game: Has a single page, simple logic -> **Simple Project** - 1 phase and 1-2 files. Initial phase should yield a perfectly working game.        
            * Building any themed 2048 game: Has a single page, simple logic -> **Simple Project** - 1 phase and 2 files max. Initial phase should yield a perfectly working game.
            * Building a full chess platform: Has multiple pages -> **Complex Project** - 3-5 phases and 5-15 files, with initial phase having around 5-11 files and should have the primary homepage working with mockups for all other views.
            * Building a full e-commerce platform: Has multiple pages -> **Complex Project** - 3-5 phases and 5-15 files max, with initial phase having around 5-11 files and should have the primary homepage working with mockups for all other views.
    </PHASE GENERATION CONSTRAINTS>`,
}

export const STRATEGIES = {
    FRONTEND_FIRST_PLANNING: `<PHASES GENERATION STRATEGY>
    **STRATEGY: Scalable, Demoable Frontend and core application First / Iterative Feature Addition later**
    The project would be developed live: The user (client) would be provided a preview link after each phase. This is our rapid development and delivery paradigm.
    The core principle is to establish a visually complete and polished frontend presentation early on with core functionalities implemented, before layering in more advanced functionality and fleshing out the backend.
    The goal is to build and demo a functional and beautiful product as fast and as early as possible.
    **Each phase should be self-contained, deployable and demoable.**
    The number of phases and files per phase should scale based on the number of views/pages and complexity of the application, layed out as follows:

    ${STRATEGIES_UTILS.INITIAL_PHASE_GUIDELINES}

    ${STRATEGIES_UTILS.SUBSEQUENT_PHASE_GUIDELINES}

    ${STRATEGIES_UTILS.CONSTRAINTS}

    **No need to add accessibility features. Focus on delivering an actually feature-wise polished and complete application in as few phases as possible.**
    **Always stick to existing project/template patterns. Respect and work with existing worker bindings rather than making custom ones**
    **Rely on open source tools and free tier services only apart from whats configured in the environment. Refer to template usage instructions to know if specific cloudflare services are also available for use.**
    **Make sure to implement all the features and functionality requested by the user and more. The application should be fully complete by the end of the last phase. There should be no compromises**
    **This is a Cloudflare Workers & Durable Objects project. The environment is preconfigured. Absolutely DO NOT Propose changes to wrangler.toml or any other config files. These config files are hidden from you but they do exist.**
    **The Homepage of the frontend is a dummy page. It should be rewritten as the primary page of the application in the initial phase.**
    **Refrain from editing any of the 'dont touch' files in the project, e.g - package.json, vite.config.ts, wrangler.jsonc, etc.**
</PHASES GENERATION STRATEGY>`, 
FRONTEND_FIRST_CODING: `<PHASES GENERATION STRATEGY>
    **STRATEGY: Scalable, Demoable Frontend and core application First / Iterative Feature Addition later**
    The project would be developed live: The user (client) would be provided a preview link after each phase. This is our rapid development and delivery paradigm.
    The core principle is to establish a visually complete and polished frontend presentation early on with core functionalities implemented, before layering in more advanced functionality and fleshing out the backend.
    The goal is to build and demo a functional and beautiful product as fast and as early as possible.
    **Each phase should be self-contained, deployable and demoable**

    ${STRATEGIES_UTILS.INITIAL_PHASE_GUIDELINES}

    ${STRATEGIES_UTILS.SUBSEQUENT_PHASE_GUIDELINES}

    ${STRATEGIES_UTILS.CODING_GUIDELINES}

    **Make sure to implement all the features and functionality requested by the user and more. The application should be fully complete by the end of the last phase. There should be no compromises**
</PHASES GENERATION STRATEGY>`, 
}

export interface GeneralSystemPromptBuilderParams {
    query: string,
    templateDetails: TemplateDetails,
    dependencies: Record<string, string>,
    forCodegen: boolean,
    blueprint?: Blueprint,
    language?: string,
    frameworks?: string[],
    templateMetaInfo?: TemplateSelection,
}

export function generalSystemPromptBuilder(
    prompt: string,
    params: GeneralSystemPromptBuilderParams
): string {
    // Base variables always present
    const variables: Record<string, string> = {
        query: params.query,
        template: PROMPT_UTILS.serializeTemplate(params.templateDetails, params.forCodegen),
        dependencies: JSON.stringify(params.dependencies || [])
    };

    // Optional blueprint variables
    if (params.blueprint) {
        variables.blueprint = TemplateRegistry.markdown.serialize(params.blueprint, BlueprintSchema);
        variables.blueprintDependencies = params.blueprint.frameworks.join(', ');
    }

    // Optional language and frameworks
    if (params.language) {
        variables.language = params.language;
    }
    if (params.frameworks) {
        variables.frameworks = params.frameworks.join(', ');
    }
    if (params.templateMetaInfo) {
        variables.usecaseSpecificInstructions = getUsecaseSpecificInstructions(params.templateMetaInfo);
    }

    const formattedPrompt = PROMPT_UTILS.replaceTemplateVariables(prompt, variables);
    return PROMPT_UTILS.verifyPrompt(formattedPrompt);
}

export function issuesPromptFormatter(issues: IssueReport): string {
    const runtimeErrorsText = issues.runtimeErrors.map((error) => `<error>${error.rawOutput}</error>`).join('\n');
    const staticAnalysisText = PROMPT_UTILS.serializeStaticAnalysis(issues.staticAnalysis);
    
    return `## ERROR ANALYSIS PRIORITY MATRIX

### 1. CRITICAL RUNTIME ERRORS (Fix First - Deployment Blockers)
**Error Count:** ${issues.runtimeErrors?.length || 0} runtime errors detected
**Contains Render Loops:** ${runtimeErrorsText.includes('Maximum update depth') || runtimeErrorsText.includes('Too many re-renders') ? 'YES - HIGHEST PRIORITY' : 'No'}

${runtimeErrorsText || 'No runtime errors detected'}

### 2. STATIC ANALYSIS ISSUES (Fix After Runtime Issues)
**Lint Issues:** ${issues.staticAnalysis?.lint?.issues?.length || 0}
**Type Issues:** ${issues.staticAnalysis?.typecheck?.issues?.length || 0}

${staticAnalysisText}

## ANALYSIS INSTRUCTIONS
- **PRIORITIZE** "Maximum update depth exceeded" and useEffect-related errors  
- **CROSS-REFERENCE** error messages with current code structure (line numbers may be outdated)
- **VALIDATE** reported issues against actual code patterns before fixing
- **FOCUS** on deployment-blocking runtime errors over linting issues`
}


export const USER_PROMPT_FORMATTER = {
    PROJECT_CONTEXT: (phases: PhaseConceptType[], files: FileOutputType[], commandsHistory: string[]) => {
        const variables: Record<string, string> = {
            phases: TemplateRegistry.markdown.serialize({ phases: phases }, z.object({ phases: z.array(PhaseConceptSchema) })),
            files: PROMPT_UTILS.serializeFiles(files),
            commandsHistory: commandsHistory.length > 0 ? `<COMMANDS HISTORY>

The following commands have been executed successfully in the project environment so far (These may not include the ones that are currently pending):

${commandsHistory.join('\n')}

</COMMANDS HISTORY>` : ''
        };

        const prompt = PROMPT_UTILS.replaceTemplateVariables(PROMPT_UTILS.PROJECT_CONTEXT, variables);
        
        return PROMPT_UTILS.verifyPrompt(prompt);
    },
};

const getStyleInstructions = (style: TemplateSelection['styleSelection']): string => {
    switch (style) {
        case `Brutalism`:
            return `
**Style Name: Brutalism**
- Characteristics: Raw aesthetics, often with bold vibrant colors on light background, large typography, large elements.
- Philosophy: Emphasizes honesty and simplicity, Non-grid, asymmetrical layouts that ignore traditional design hierarchy.
- Example Elements: Large, blocky layouts, heavy use of whitespace, unconventional navigation patterns.
`;
        case 'Retro':
            return `
**Style Name: Retro**
- Characteristics: Early-Internet graphics, pixel art, 3D objects, or glitch effects.
- Philosophy: Nostalgia-driven, aiming to evoke the look and feel of 90s or early 2000s web culture.
- Example Elements: Neon palettes, grainy textures, gradient meshes, and quirky fonts.`;
        case 'Illustrative':
            return `
**Style Name: Illustrative**
- Characteristics: Custom illustrations, sketchy graphics, and playful elements
- Philosophy: Human-centered, whimsical, and expressive.
- Example Elements: Cartoon-style characters, brushstroke fonts, animated SVGs.
- Heading Font options: Playfair Display, Fredericka the Great, Great Vibes
            `
//         case 'Neumorphism':
//             return `
// **Style Name: Neumorphism (Soft UI)**
// - Use a soft pastel background, high-contrast accent colors for functional elements e.g. navy, coral, or bright blue. Avoid monochrome UIs
// - Light shadow (top-left) and dark shadow (bottom-right) to simulate extrusion or embedding, Keep shadows subtle but visible to prevent a washed-out look.
// - Avoid excessive transparency in text — keep readability high.
// - Integrate glassmorphism subtly`;
        case `Kid_Playful`:
            return `
**Style Name: Kid Playful**
- Bright, contrasting colors
- Stylized illustrations resembling 2D animation or children's book art
- Smooth, rounded shapes and clean borders—no gradients or realism
- Similar to Pablo Stanley, Burnt Toast Creative, or Outline-style art.
- Children’s book meets modern web`
        case 'Minimalist Design':
            return `
**Style Name: Minimalist Design**
Characteristics: Clean layouts, lots of white space, limited color palettes, and simple typography.
Philosophy: "Less is more." Focuses on clarity and usability.
Example Elements: Monochrome schemes, subtle animations, grid-based layouts.
** Apply a gradient background or subtle textures to the hero section for depth and warmth.
`
    }
    return `
** Apply a gradient background or subtle textures to the hero section for depth and warmth.
** Choose a modern sans-serif font like Inter, Sora, or DM Sans
** Use visual contrast: white or light background, or very soft gradient + clean black text.
    `
};

const SAAS_LANDING_INSTRUCTIONS = (style: TemplateSelection['styleSelection']): string => `
** If there is no brand/product name specified, come up with a suitable name
** Include a prominent hero section with a headline, subheadline, and a clear call-to-action (CTA) button above the fold.
** Insert a pricing table with tiered plans if applicable
** Design a footer with key navigation links, company info, social icons, and a newsletter sign-up.
** Add a product feature section using icon-text pairs or cards to showcase 3-6 key benefits.
** Use a clean, modern layout with generous white space and a clear visual hierarchy
** Show the magic live i.e if possible show a small demo of the product. Only if simple and feasible.
** Generate SVG illustrations where absolutely relevant.

Use the following artistic style:
${getStyleInstructions(style)}
`;

const ECOMM_INSTRUCTIONS = (): string => `
** If there is no brand/product name specified, come up with a suitable name
** Include a prominent hero section with a headline, subheadline, and a clear call-to-action (CTA) button above the fold.
** Insert a product showcase section with high-quality images, descriptions, and prices.
** Provide a collapsible sidebar (desktop) or an expandable top bar (tablet/mobile) containing filters (category, price range slider, brand, color swatches), so users can refine results without leaving the page.
** Use a clean, modern layout with generous white space and a clear visual hierarchy
`;

const DASHBOARD_INSTRUCTIONS = (): string => `
** If applicable to user query group Related Controls and Forms into Well-Labeled Cards / Panels
** If applicable to user query offer Quick Actions / Shortcuts for Common Tasks
** If user asked for analytics/visualizations/statistics - Show sparklines, mini line/bar charts, or simple pie indicators for trends 
** If user asked for analytics/visualizations/statistics - Maybe show key metrics in modular cards
** If applicable to user query make It Interactive and Contextual (Filters, Search, Pagination)
** If applicable to user query add a sidebar and or tabs
** Dashboard should be information dense.
`;

export const getUsecaseSpecificInstructions = (selectedTemplate: TemplateSelection): string => {
    switch (selectedTemplate.useCase) {
        case 'SaaS Product Website':
            return SAAS_LANDING_INSTRUCTIONS(selectedTemplate.styleSelection);
        case 'E-Commerce':
            return ECOMM_INSTRUCTIONS();
        case 'Dashboard':
            return DASHBOARD_INSTRUCTIONS();
        default:
            return `Use the following artistic style:
            ${getStyleInstructions(selectedTemplate.styleSelection)}`;
    }
}
