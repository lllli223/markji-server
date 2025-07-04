#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from 'axios';
import FormData from 'form-data';

// All API requests need a token. The user will provide this.
// For the MCP server, we'll get it from an environment variable.
const MARKJI_TOKEN = process.env.MARKJI_TOKEN;

if (!MARKJI_TOKEN) {
  // We can't use console.error and exit because it will kill the MCP process.
  // Throwing an error is the correct way to signal a fatal configuration issue.
  throw new Error('MARKJI_TOKEN environment variable is required. Please add it to the MCP server configuration.');
}

// Create an MCP server instance
const server = new McpServer({
  name: "markji-server",
  version: "1.2.0",
  description: "A server to interact with the Markji (墨墨记忆卡) API to create flashcards."
});

// Create an axios instance for all Markji API calls
const markjiApi = axios.create({
  baseURL: 'https://www.markji.com/api/v1',
  headers: {
    'token': MARKJI_TOKEN,
    'Content-Type': 'application/json; charset=utf-8'
  }
});

// --- Helper Functions ---

// Based on the browser extension, new cards are added to the last chapter of a deck.
async function getLastChapterId(deckId: string): Promise<string> {
  try {
    const response = await markjiApi.get(`/decks/${deckId}/chapters`);
    const chapters = response.data?.data?.chapterset?.chapter_ids;
    if (!chapters || chapters.length === 0) {
      throw new Error(`No chapters found for deck ${deckId}.`);
    }
    return chapters[chapters.length - 1];
  } catch (error) {
    // Re-throw with more context
    if (axios.isAxiosError(error)) {
        const errorMessage = error.response?.data?.errors?.[0]?.message || error.message;
        throw new Error(`Failed to get chapters for deck ${deckId}: ${errorMessage}`);
    }
    throw error;
  }
}

// Based on the browser extension, images are first uploaded to get a file ID.
async function uploadImageFromUrl(imageUrl: string): Promise<string> {
    try {
        // 1. Download the image data
        const imageResponse = await axios.get(imageUrl, {
            responseType: 'arraybuffer'
        });
        const imageBuffer = Buffer.from(imageResponse.data, 'binary');
        const contentType = imageResponse.headers['content-type'] || 'image/jpeg';
        const extension = contentType.split('/')[1] || 'jpg';
        const fileName = `mcp-upload.${extension}`;

        // 2. Create FormData and append the file buffer
        const formData = new FormData();
        formData.append('file', imageBuffer, {
            filename: fileName,
            contentType: contentType,
        });

        // 3. Upload to Markji
        const uploadResponse = await markjiApi.post('/files', formData, {
            headers: {
                ...formData.getHeaders() // Important for multipart/form-data
            }
        });

        const fileId = uploadResponse.data?.data?.file?.id;
        if (!fileId) {
            throw new Error('File ID not found in upload response.');
        }
        return fileId;

    } catch (error) {
        if (axios.isAxiosError(error)) {
            const errorMessage = error.response?.data?.errors?.[0]?.message || error.message;
            throw new Error(`Failed to upload image from URL ${imageUrl}: ${errorMessage}`);
        }
        throw error;
    }
}

// Helper function to get card details (needed for updates to preserve grammar_version)
async function getCardDetails(deckId: string, cardId: string): Promise<any> {
    try {
        const response = await markjiApi.get(`/decks/${deckId}/cards/${cardId}`);
        if (!response.data?.success) {
            throw new Error('Failed to get card details from API response');
        }
        return response.data.data.card;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            const errorMessage = error.response?.data?.errors?.[0]?.message || error.message;
            throw new Error(`Failed to get card details: ${errorMessage}`);
        }
        throw error;
    }
}

// Helper function to batch get card details for multiple cards
async function batchGetCardDetails(deckId: string, cardIds: string[]): Promise<Map<string, any>> {
    try {
        const promises = cardIds.map(cardId =>
            getCardDetails(deckId, cardId).then(card => ({ cardId, card }))
        );
        
        const settledResults = await Promise.allSettled(promises);
        const cardDetailsMap = new Map<string, any>();
        
        settledResults.forEach((result, index) => {
            const cardId = cardIds[index];
            if (result.status === 'fulfilled') {
                cardDetailsMap.set(cardId, result.value.card);
            } else {
                // For failed cards, we'll handle this in the calling function
                console.error(`Failed to get details for card ${cardId}:`, result.reason);
            }
        });
        
        return cardDetailsMap;
    } catch (error) {
        throw new Error(`Failed to batch get card details: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

// --- MCP Tools ---

// Tool 1: List all available decks for the user, including their folder information.
server.tool(
  "listDecks",
  {
    // No input parameters needed
  },
  async () => {
    try {
      // 1. Fetch both the folder structure and the full deck list in parallel.
      const [foldersResponse, decksResponse] = await Promise.all([
        markjiApi.get('/decks/folders'),
        markjiApi.get('/decks')
      ]);

      // 2. Create a lookup map for deck details (ID -> Name).
      const allDecks = decksResponse.data?.data?.decks || [];
      const deckMap = new Map<string, string>();
      for (const deck of allDecks) {
        deckMap.set(deck.id, deck.name);
      }

      // 3. Process the folder structure to build the enriched list.
      const folders = foldersResponse.data?.data?.folders || [];
      const enrichedDecks = [];
      const processedDeckIds = new Set<string>();

      for (const folder of folders) {
        // Skip the root folder which just contains other folders
        if (folder.name === 'root') continue;

        const items = folder.items || [];
        for (const item of items) {
          if (item.object_class === 'DECK') {
            const deckId = item.object_id;
            const deckName = deckMap.get(deckId);
            if (deckName) {
              enrichedDecks.push({
                deckId: deckId,
                deckName: deckName,
                folderId: folder.id,
                folderName: folder.name,
              });
              processedDeckIds.add(deckId);
            }
          }
        }
      }

      // 4. Find any remaining decks that weren't in a folder.
      for (const deck of allDecks) {
        if (!processedDeckIds.has(deck.id)) {
          enrichedDecks.push({
            deckId: deck.id,
            deckName: deck.name,
            folderId: null,
            folderName: '未分类',
          });
        }
      }

      if (enrichedDecks.length === 0) {
          return { content: [{ type: "text", text: "No decks found." }] };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(enrichedDecks, null, 2),
          },
        ],
      };
    } catch (error) {
        let errorMessage = 'An unknown error occurred';
        if (axios.isAxiosError(error)) {
            const apiError = error.response?.data?.errors?.[0]?.message;
            errorMessage = `API Error: ${apiError}` || `Status ${error.response?.status}: ${error.message}`;
        } else if (error instanceof Error) {
            errorMessage = error.message;
        }
        return { content: [{ type: "text", text: `Failed to list decks: ${errorMessage}` }], isError: true };
    }
  }
);

// Tool 2: Add single or multiple text cards to a specific deck
const cardSchema = z.object({
    content: z.string().describe("The front content of the card."),
    backContent: z.string().optional().describe("The back content of the card.")
});

const addTextCardsSchema = z.object({
    deckId: z.string().describe("The ID of the deck to add the cards to."),
    cards: z.union([cardSchema, z.array(cardSchema)]).describe("A single card object or an array of card objects to add."),
    chapterId: z.string().optional().describe("The ID of the specific chapter to add cards to. If not provided, cards will be added to the last chapter of the deck.")
});

server.tool(
  "addTextCards",
  addTextCardsSchema.shape,
  async ({ deckId, cards, chapterId }: z.infer<typeof addTextCardsSchema>) => {
    try {
        // Use provided chapterId or get the last chapter
        const targetChapterId = chapterId || await getLastChapterId(deckId);
        
        const cardsArray = Array.isArray(cards) ? cards : [cards];

        // Use Promise.allSettled to send requests concurrently
        const promises = cardsArray.map((card, index) => {
            const cardContent = card.backContent ? `${card.content}\n---\n${card.backContent}` : card.content;
            const payload = {
                order: index + 1, // Add order based on array position
                card: {
                    content: cardContent,
                    grammar_version: 3, // Update grammar_version to 3
                },
            };
            return markjiApi.post(`/decks/${deckId}/chapters/${targetChapterId}/cards`, payload);
        });

        const settledResults = await Promise.allSettled(promises);

        const results: string[] = [];
        let successCount = 0;
        let failureCount = 0;

        settledResults.forEach((result, index) => {
            const cardContent = cardsArray[index].content.substring(0, 20);
            if (result.status === 'fulfilled') {
                const response = result.value;
                if (response.data?.success) {
                    results.push(`✅ Successfully created card: ${response.data.data.card.id}`);
                    successCount++;
                } else {
                    const errorMessage = response.data?.errors?.[0]?.message || 'Unknown API error';
                    results.push(`❌ Failed to create card "${cardContent}...": ${errorMessage}`);
                    failureCount++;
                }
            } else {
                // Handle rejected promises (network errors, etc.)
                let errorMessage = 'An unknown error occurred';
                if (axios.isAxiosError(result.reason)) {
                    errorMessage = result.reason.response?.data?.errors?.[0]?.message || `Status ${result.reason.response?.status}: ${result.reason.message}`;
                } else if (result.reason instanceof Error) {
                    errorMessage = result.reason.message;
                }
                results.push(`❌ Failed to create card "${cardContent}...": ${errorMessage}`);
                failureCount++;
            }
        });

        const summary = `Batch operation summary: ${successCount} succeeded, ${failureCount} failed.`;
        const report = [summary, ...results].join('\n');

        return {
            content: [{ type: "text", text: report }],
            isError: failureCount > 0
        };

    } catch (error) {
        let errorMessage = 'An unknown error occurred';
        if (error instanceof Error) {
            errorMessage = error.message;
        }
        return { content: [{ type: "text", text: `Failed to add text cards: ${errorMessage}` }], isError: true };
    }
  }
);

// Tool 3: Add an image-based card to a specific deck from a URL
const addImageCardSchema = z.object({
    deckId: z.string().describe("The ID of the deck to add the card to. Can be obtained from listDecks."),
    imageUrl: z.string().url().describe("The public URL of the image to add."),
    caption: z.string().optional().describe("An optional caption for the image."),
    chapterId: z.string().optional().describe("The ID of the specific chapter to add the card to. If not provided, the card will be added to the last chapter of the deck.")
});

server.tool(
    "addImageCard",
    addImageCardSchema.shape,
    async ({ deckId, imageUrl, caption, chapterId }: z.infer<typeof addImageCardSchema>) => {
        try {
            const fileId = await uploadImageFromUrl(imageUrl);
            const cardContent = caption ? `${caption}\n[Pic#${fileId}#]` : `[Pic#${fileId}#]`;
            
            // Use provided chapterId or get the last chapter
            const targetChapterId = chapterId || await getLastChapterId(deckId);

            const payload = {
                card: {
                    content: cardContent,
                    grammar_version: 2,
                },
            };

            const response = await markjiApi.post(`/decks/${deckId}/chapters/${targetChapterId}/cards`, payload);

            if (response.data?.success) {
                return {
                    content: [{ type: "text", text: `Successfully created image card with ID: ${response.data.data.card.id}` }],
                };
            } else {
                const errorMessage = response.data?.errors?.[0]?.message || 'Unknown error from Markji API.';
                return { content: [{ type: "text", text: `Failed to create image card: ${errorMessage}` }], isError: true };
            }

        } catch (error) {
            let errorMessage = 'An unknown error occurred';
            if (error instanceof Error) {
                errorMessage = error.message;
            }
            return { content: [{ type: "text", text: `Failed to add image card: ${errorMessage}` }], isError: true };
        }
    }
);

// Tool 4: List all available folders
server.tool(
  "listFolders",
  {},
  async () => {
    try {
      const response = await markjiApi.get('/decks/folders');
      const folders = response.data?.data?.folders?.map((folder: any) => ({
          id: folder.id,
          name: folder.name
      }));

      if (!folders) {
          return { content: [{ type: "text", text: "Could not parse folders from API response." }], isError: true };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(folders, null, 2),
          },
        ],
      };
    } catch (error) {
        let errorMessage = 'An unknown error occurred';
        if (axios.isAxiosError(error)) {
            errorMessage = error.response?.data?.errors?.[0]?.message || `Status ${error.response?.status}: ${error.message}`;
        } else if (error instanceof Error) {
            errorMessage = error.message;
        }
        return { content: [{ type: "text", text: `Failed to list folders: ${errorMessage}` }], isError: true };
    }
  }
);

// Tool 5: Create a new deck
const createDeckSchema = z.object({
    name: z.string().describe("The name for the new deck."),
    folderId: z.string().describe("The ID of the folder to create the deck in. Can be obtained from listFolders."),
    description: z.string().optional().describe("An optional description for the new deck."),
    isPrivate: z.boolean().optional().default(false).describe("Whether the deck should be private. Defaults to false.")
});

server.tool(
  "createDeck",
  createDeckSchema.shape,
  async ({ name, folderId, description, isPrivate }: z.infer<typeof createDeckSchema>) => {
    try {
        const payload = {
            name: name,
            description: description || '',
            is_private: isPrivate,
            folder_id: folderId
        };
        const response = await markjiApi.post('/decks', payload);

        if (response.data?.success) {
            const newDeck = response.data.data.deck;
            const newDeckId = newDeck.id;

            // Now, create a default chapter for the new deck
            try {
                const chapterPayload = { name: "默认章节" }; // Default chapter name
                const chapterResponse = await markjiApi.post(`/decks/${newDeckId}/chapters`, chapterPayload);

                if (chapterResponse.data?.success) {
                    const newChapter = chapterResponse.data.data.chapter;
                    return {
                        content: [{ type: "text", text: JSON.stringify({
                            message: `Successfully created deck with ID: ${newDeckId}`,
                            deckId: newDeckId,
                            deckName: newDeck.name,
                            defaultChapterId: newChapter.id,
                            defaultChapterName: newChapter.name
                        }, null, 2) }],
                    };
                } else {
                    // If chapter creation fails, still return success for the deck, but with a warning.
                    const chapterErrorMessage = chapterResponse.data?.errors?.[0]?.message || 'Unknown error';
                     return {
                        content: [{ type: "text", text: JSON.stringify({
                            message: `Successfully created deck with ID: ${newDeckId}, but failed to create a default chapter.`,
                            warning: `Chapter creation failed: ${chapterErrorMessage}`,
                            deckId: newDeckId,
                            deckName: newDeck.name,
                        }, null, 2) }],
                        isError: true // Indicate a partial failure
                    };
                }
            } catch (chapterError) {
                 let chapterErrorMessage = 'An unknown error occurred during chapter creation';
                 if (axios.isAxiosError(chapterError)) {
                    chapterErrorMessage = chapterError.response?.data?.errors?.[0]?.message || chapterError.message;
                 } else if (chapterError instanceof Error) {
                    chapterErrorMessage = chapterError.message;
                 }
                 return {
                        content: [{ type: "text", text: JSON.stringify({
                            message: `Successfully created deck with ID: ${newDeckId}, but failed to create a default chapter.`,
                            warning: chapterErrorMessage,
                            deckId: newDeckId,
                            deckName: newDeck.name,
                        }, null, 2) }],
                        isError: true
                    };
            }
        } else {
            const errorMessage = response.data?.errors?.[0]?.message || 'Unknown error from Markji API.';
            return { content: [{ type: "text", text: `Failed to create deck: ${errorMessage}` }], isError: true };
        }
    } catch (error) {
        let errorMessage = 'An unknown error occurred';
        if (error instanceof Error) {
            errorMessage = error.message;
        }
        return { content: [{ type: "text", text: `Failed to create deck: ${errorMessage}` }], isError: true };
    }
  }
);

// Tool 6: Add single or multiple chapters to a specific deck
const chapterSchema = z.object({
    name: z.string().describe("The name of the chapter."),
});

const addChaptersSchema = z.object({
    deckId: z.string().describe("The ID of the deck to add the chapters to."),
    chapters: z.union([chapterSchema, z.array(chapterSchema)]).describe("A single chapter object or an array of chapter objects to add.")
});

server.tool(
  "addChapters",
  addChaptersSchema.shape,
  async ({ deckId, chapters }: z.infer<typeof addChaptersSchema>) => {
    try {
        const chaptersArray = Array.isArray(chapters) ? chapters : [chapters];

        const promises = chaptersArray.map(chapter => {
            const payload = { name: chapter.name };
            return markjiApi.post(`/decks/${deckId}/chapters`, payload);
        });
        const settledResults = await Promise.allSettled(promises);

        const results: string[] = [];
        const createdChaptersMap: { [name: string]: string } = {}; // For the new return value
        let successCount = 0;
        let failureCount = 0;

        settledResults.forEach((result, index) => {
            const chapterName = chaptersArray[index].name;
            if (result.status === 'fulfilled') {
                const response = result.value;
                if (response.data?.success) {
                    const newChapter = response.data.data.chapter;
                    results.push(`✅ Successfully created chapter: ${newChapter.id}`);
                    createdChaptersMap[chapterName] = newChapter.id; // Populate the map
                    successCount++;
                } else {
                    const errorMessage = response.data?.errors?.[0]?.message || 'Unknown API error';
                    results.push(`❌ Failed to create chapter "${chapterName}": ${errorMessage}`);
                    failureCount++;
                }
            } else {
                let errorMessage = 'An unknown error occurred';
                if (axios.isAxiosError(result.reason)) {
                    errorMessage = result.reason.response?.data?.errors?.[0]?.message || `Status ${result.reason.response?.status}: ${result.reason.message}`;
                } else if (result.reason instanceof Error) {
                    errorMessage = result.reason.message;
                }
                results.push(`❌ Failed to create chapter "${chapterName}": ${errorMessage}`);
                failureCount++;
            }
        });

        const summary = `Batch operation summary: ${successCount} succeeded, ${failureCount} failed.`;
        const report = [summary, ...results].join('\n');
        
        // New return structure
        const finalReport = {
            summary: report,
            createdChapters: createdChaptersMap
        };

        return {
            content: [{ type: "text", text: JSON.stringify(finalReport, null, 2) }],
            isError: failureCount > 0
        };

    } catch (error) {
        let errorMessage = 'An unknown error occurred';
        if (error instanceof Error) {
            errorMessage = error.message;
        }
        return { content: [{ type: "text", text: `Failed to add chapters: ${errorMessage}` }], isError: true };
    }
  }
);

// Tool 7: List all chapters in a specific deck
const listChaptersSchema = z.object({
    deckId: z.string().describe("The ID of the deck to list chapters for."),
});

server.tool(
  "listChapters",
  listChaptersSchema.shape,
  async ({ deckId }: z.infer<typeof listChaptersSchema>) => {
    try {
      const response = await markjiApi.get(`/decks/${deckId}/chapters`);
      const chapters = response.data?.data?.chapters || [];

      if (!chapters || chapters.length === 0) {
          return { content: [{ type: "text", text: `No chapters found for deck ${deckId}.` }], isError: true };
      }

      const simplifiedChapters = chapters.map((ch: any) => ({
          id: ch.id,
          name: ch.name,
          cardCount: (ch.card_ids || []).length,
          cardIds: ch.card_ids || []
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(simplifiedChapters, null, 2),
          },
        ],
      };
    } catch (error) {
        let errorMessage = 'An unknown error occurred';
        if (axios.isAxiosError(error)) {
            errorMessage = error.response?.data?.errors?.[0]?.message || `Status ${error.response?.status}: ${error.message}`;
        } else if (error instanceof Error) {
            errorMessage = error.message;
        }
        return { content: [{ type: "text", text: `Failed to list chapters for deck ${deckId}: ${errorMessage}` }], isError: true };
    }
  }
);

// Tool 8: Move cards to a specific chapter, creating the chapter if it doesn't exist.
const moveCardsSchema = z.object({
    deckId: z.string().describe("The ID of the deck containing the cards."),
    fromChapterId: z.string().describe("The ID of the chapter the cards are currently in."),
    cardIds: z.array(z.string()).min(1).describe("An array of card IDs to move."),
    toChapterName: z.string().describe("The name of the destination chapter. It will be created if it doesn't exist."),
    order: z.number().optional().default(0).describe("The position of the cards in the new chapter (0 for top).")
});

server.tool(
  "moveCardsToChapter",
  moveCardsSchema.shape,
  async ({ deckId, fromChapterId, cardIds, toChapterName, order }: z.infer<typeof moveCardsSchema>) => {
    try {
        // 1. Find or create the destination chapter
        let toChapterId: string;

        // 1a. Fetch all existing chapters in the deck
        const chaptersResponse = await markjiApi.get(`/decks/${deckId}/chapters`);
        const existingChapters = chaptersResponse.data?.data?.chapters || [];
        const targetChapter = existingChapters.find((ch: any) => ch.name === toChapterName);

        if (targetChapter) {
            // 1b. If chapter exists, use its ID
            toChapterId = targetChapter.id;
        } else {
            // 1c. If chapter does not exist, create it
            const createChapterResponse = await markjiApi.post(`/decks/${deckId}/chapters`, { name: toChapterName });
            if (!createChapterResponse.data?.success) {
                const errorMessage = createChapterResponse.data?.errors?.[0]?.message || 'Failed to create new chapter';
                throw new Error(errorMessage);
            }
            toChapterId = createChapterResponse.data.data.chapter.id;
        }

        // 2. Move the cards
        const movePayload = {
            to_chapter_id: toChapterId,
            card_ids: cardIds,
            order: order || 0
        };

        const moveResponse = await markjiApi.post(`/decks/${deckId}/chapters/${fromChapterId}/cards/move`, movePayload);

        if (moveResponse.data?.success) {
            return {
                content: [{ type: "text", text: `Successfully moved ${cardIds.length} card(s) to chapter "${toChapterName}" (ID: ${toChapterId}).` }],
            };
        } else {
            const errorMessage = moveResponse.data?.errors?.[0]?.message || 'Unknown error during card move operation.';
            throw new Error(errorMessage);
        }

    } catch (error) {
        let errorMessage = 'An unknown error occurred';
        if (error instanceof Error) {
            errorMessage = error.message;
        }
        return { content: [{ type: "text", text: `Operation failed: ${errorMessage}` }], isError: true };
    }
  }
);

// Tool 9: Batch move multiple cards to different chapters in a single operation
const batchMoveOperation = z.object({
    fromChapterId: z.string().describe("The ID of the source chapter."),
    toChapterName: z.string().describe("The name of the destination chapter (will be created if it doesn't exist)."),
    cardIds: z.array(z.string()).min(1).describe("Array of card IDs to move."),
    order: z.number().optional().default(0).describe("Position in the destination chapter (0 for top).")
});

const batchMoveCardsSchema = z.object({
    deckId: z.string().describe("The ID of the deck containing all the cards."),
    operations: z.array(batchMoveOperation).min(1).describe("Array of move operations to perform.")
});

server.tool(
  "batchMoveCards",
  batchMoveCardsSchema.shape,
  async ({ deckId, operations }: z.infer<typeof batchMoveCardsSchema>) => {
    try {
        const results = [];
        let successCount = 0;
        let failureCount = 0;

        // Get existing chapters first
        const chaptersResponse = await markjiApi.get(`/decks/${deckId}/chapters`);
        const existingChapters = chaptersResponse.data?.data?.chapters || [];
        const chapterMap = new Map<string, string>(); // name -> id
        
        existingChapters.forEach((ch: any) => {
            chapterMap.set(ch.name, ch.id);
        });

        for (const operation of operations) {
            try {
                let toChapterId: string;

                // Check if target chapter exists, create if not
                if (chapterMap.has(operation.toChapterName)) {
                    toChapterId = chapterMap.get(operation.toChapterName)!;
                } else {
                    // Create new chapter
                    const createResponse = await markjiApi.post(`/decks/${deckId}/chapters`, {
                        name: operation.toChapterName
                    });
                    
                    if (!createResponse.data?.success) {
                        const errorMessage = createResponse.data?.errors?.[0]?.message || 'Failed to create chapter';
                        throw new Error(`Failed to create chapter "${operation.toChapterName}": ${errorMessage}`);
                    }
                    
                    toChapterId = createResponse.data.data.chapter.id;
                    chapterMap.set(operation.toChapterName, toChapterId);
                    results.push(`Created new chapter: "${operation.toChapterName}" (ID: ${toChapterId})`);
                }

                // Move the cards
                const movePayload = {
                    to_chapter_id: toChapterId,
                    card_ids: operation.cardIds,
                    order: operation.order
                };

                const moveResponse = await markjiApi.post(
                    `/decks/${deckId}/chapters/${operation.fromChapterId}/cards/move`,
                    movePayload
                );

                if (moveResponse.data?.success) {
                    results.push(`✅ Moved ${operation.cardIds.length} card(s) to "${operation.toChapterName}"`);
                    successCount++;
                } else {
                    const errorMessage = moveResponse.data?.errors?.[0]?.message || 'Unknown move error';
                    results.push(`❌ Failed to move cards to "${operation.toChapterName}": ${errorMessage}`);
                    failureCount++;
                }

            } catch (error) {
                let errorMessage = 'Unknown error';
                if (error instanceof Error) {
                    errorMessage = error.message;
                }
                results.push(`❌ Operation failed for "${operation.toChapterName}": ${errorMessage}`);
                failureCount++;
            }
        }

        const summary = `Batch move completed: ${successCount} operations succeeded, ${failureCount} failed.`;
        const report = [summary, ...results].join('\n');

        return {
            content: [{ type: "text", text: report }],
            isError: failureCount > 0
        };

    } catch (error) {
        let errorMessage = 'An unknown error occurred';
        if (error instanceof Error) {
            errorMessage = error.message;
        }
        return { content: [{ type: "text", text: `Batch move operation failed: ${errorMessage}` }], isError: true };
    }
  }
);

// Tool 10: Get detailed information for specific cards
const getCardsSchema = z.object({
    deckId: z.string().describe("The ID of the deck containing the cards."),
    cardIds: z.array(z.string()).min(1).describe("An array of card IDs to retrieve details for.")
});

server.tool(
  "getCards",
  getCardsSchema.shape,
  async ({ deckId, cardIds }: z.infer<typeof getCardsSchema>) => {
    try {
        const promises = cardIds.map(cardId => getCardDetails(deckId, cardId));
        const settledResults = await Promise.allSettled(promises);

        const results: any[] = [];
        let successCount = 0;
        let failureCount = 0;

        settledResults.forEach((result, index) => {
            const cardId = cardIds[index];
            if (result.status === 'fulfilled') {
                const cardDetails = result.value;
                results.push({
                    cardId: cardId,
                    content: cardDetails.content,
                    grammarVersion: cardDetails.grammar_version,
                    createdAt: cardDetails.created_at,
                    updatedAt: cardDetails.updated_at
                });
                successCount++;
            } else {
                let errorMessage = 'An unknown error occurred';
                if (result.reason instanceof Error) {
                    errorMessage = result.reason.message;
                }
                results.push({
                    cardId: cardId,
                    error: errorMessage
                });
                failureCount++;
            }
        });

        const summary = `Retrieved ${successCount} card(s) successfully, ${failureCount} failed.`;
        const report = {
            summary,
            cards: results
        };

        return {
            content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
            isError: failureCount > 0
        };

    } catch (error) {
        let errorMessage = 'An unknown error occurred';
        if (error instanceof Error) {
            errorMessage = error.message;
        }
        return { content: [{ type: "text", text: `Failed to get cards: ${errorMessage}` }], isError: true };
    }
  }
);

// Tool 11: Update existing cards
const updateCardSchema = z.object({
    deckId: z.string().describe("The ID of the deck containing the card."),
    cardId: z.string().describe("The ID of the card to update."),
    content: z.string().describe("The new content for the card."),
    backContent: z.string().optional().describe("The new back content for the card.")
});

server.tool(
  "updateCard",
  updateCardSchema.shape,
  async ({ deckId, cardId, content, backContent }: z.infer<typeof updateCardSchema>) => {
    try {
        // First get the current card to preserve grammar_version
        const currentCard = await getCardDetails(deckId, cardId);
        
        // Format the new content
        const newContent = backContent ? `${content}\n---\n${backContent}` : content;
        
        const payload = {
            card: {
                content: newContent,
                grammar_version: currentCard.grammar_version // Preserve the original grammar_version
            }
        };

        const response = await markjiApi.post(`/decks/${deckId}/cards/${cardId}`, payload);

        if (response.data?.success) {
            return {
                content: [{ type: "text", text: `Successfully updated card ${cardId}` }],
            };
        } else {
            const errorMessage = response.data?.errors?.[0]?.message || 'Unknown error from Markji API.';
            return { content: [{ type: "text", text: `Failed to update card: ${errorMessage}` }], isError: true };
        }

    } catch (error) {
        let errorMessage = 'An unknown error occurred';
        if (error instanceof Error) {
            errorMessage = error.message;
        }
        return { content: [{ type: "text", text: `Failed to update card: ${errorMessage}` }], isError: true };
    }
  }
);

// Tool 12: Delete cards
const deleteCardsSchema = z.object({
    deckId: z.string().describe("The ID of the deck containing the cards."),
    cardIds: z.array(z.string()).min(1).describe("An array of card IDs to delete.")
});

server.tool(
  "deleteCards",
  deleteCardsSchema.shape,
    async ({ deckId, cardIds }: z.infer<typeof deleteCardsSchema>) => {
      try {
          // 1. Fetch all chapters once to create a lookup map for card -> chapter.
          const chaptersResponse = await markjiApi.get(`/decks/${deckId}/chapters`);
          const chapters = chaptersResponse.data?.data?.chapters || [];
          const cardToChapterMap = new Map<string, string>();
          for (const chapter of chapters) {
              for (const cardId of chapter.card_ids || []) {
                  cardToChapterMap.set(cardId, chapter.id);
              }
          }
  
          // 2. Create a delete promise for each card.
          const deletePromises = cardIds.map(cardId => {
              const chapterId = cardToChapterMap.get(cardId);
              if (!chapterId) {
                  // Return a rejected promise for cards not found
                  return Promise.reject(new Error(`Card ${cardId} not found in any chapter.`));
              }
              return markjiApi.delete(`/decks/${deckId}/chapters/${chapterId}/cards/${cardId}`);
          });
  
          // 3. Execute all delete promises concurrently.
          const settledResults = await Promise.allSettled(deletePromises);
  
          const results: string[] = [];
          let successCount = 0;
          let failureCount = 0;
  
          settledResults.forEach((result, index) => {
              const cardId = cardIds[index];
              if (result.status === 'fulfilled') {
                  const response = result.value;
                  if (response.data?.success) {
                      results.push(`✅ Successfully deleted card: ${cardId}`);
                      successCount++;
                  } else {
                      const errorMessage = response.data?.errors?.[0]?.message || 'Unknown API error';
                      results.push(`❌ Failed to delete card ${cardId}: ${errorMessage}`);
                      failureCount++;
                  }
              } else {
                  // Handle rejected promises (e.g., card not found, network errors)
                  let errorMessage = 'An unknown error occurred';
                  if (result.reason instanceof Error) {
                      errorMessage = result.reason.message;
                  }
                  results.push(`❌ Failed to delete card ${cardId}: ${errorMessage}`);
                  failureCount++;
              }
          });
  
          const summary = `Delete operation completed: ${successCount} succeeded, ${failureCount} failed.`;
          const report = [summary, ...results].join('\n');
  
          return {
              content: [{ type: "text", text: report }],
              isError: failureCount > 0
          };
  
      } catch (error) {
          let errorMessage = 'An unknown error occurred';
          if (error instanceof Error) {
              errorMessage = error.message;
          }
          return { content: [{ type: "text", text: `Failed to delete cards: ${errorMessage}` }], isError: true };
      }
    }
);

// Tool 13: Batch update multiple cards
const cardUpdateSchema = z.object({
    cardId: z.string().describe("The ID of the card to update."),
    content: z.string().describe("The new content for the card."),
    backContent: z.string().optional().describe("The new back content for the card.")
});

const batchUpdateCardsSchema = z.object({
    deckId: z.string().describe("The ID of the deck containing the cards."),
    updates: z.array(cardUpdateSchema).min(1).describe("An array of card update objects.")
});

server.tool(
  "batchUpdateCards",
  batchUpdateCardsSchema.shape,
  async ({ deckId, updates }: z.infer<typeof batchUpdateCardsSchema>) => {
    try {
        // Step 1: Batch get all card details first
        const cardIds = updates.map(update => update.cardId);
        const cardDetailsMap = await batchGetCardDetails(deckId, cardIds);
        
        // Step 2: Prepare update promises using the fetched card details
        const updatePromises = updates.map(async (update) => {
            try {
                const currentCard = cardDetailsMap.get(update.cardId);
                if (!currentCard) {
                    throw new Error(`Card details not found for card ${update.cardId}`);
                }
                
                // Format the new content
                const newContent = update.backContent ? `${update.content}\n---\n${update.backContent}` : update.content;
                
                const payload = {
                    card: {
                        content: newContent,
                        grammar_version: currentCard.grammar_version // Preserve the original grammar_version
                    }
                };

                const response = await markjiApi.post(`/decks/${deckId}/cards/${update.cardId}`, payload);
                return { cardId: update.cardId, response, success: true };
            } catch (error) {
                return { cardId: update.cardId, error, success: false };
            }
        });

        // Step 3: Execute all updates concurrently
        const settledResults = await Promise.allSettled(updatePromises);
        
        const results: string[] = [];
        let successCount = 0;
        let failureCount = 0;

        settledResults.forEach((result, index) => {
            const cardId = updates[index].cardId;
            
            if (result.status === 'fulfilled') {
                const { success, response, error } = result.value;
                if (success && response?.data?.success) {
                    results.push(`✅ Successfully updated card: ${cardId}`);
                    successCount++;
                } else {
                    const errorMessage = response?.data?.errors?.[0]?.message ||
                        (error instanceof Error ? error.message : 'Unknown error');
                    results.push(`❌ Failed to update card ${cardId}: ${errorMessage}`);
                    failureCount++;
                }
            } else {
                let errorMessage = 'An unknown error occurred';
                if (result.reason instanceof Error) {
                    errorMessage = result.reason.message;
                }
                results.push(`❌ Failed to update card ${cardId}: ${errorMessage}`);
                failureCount++;
            }
        });

        const summary = `Batch update completed: ${successCount} succeeded, ${failureCount} failed.`;
        const report = [summary, ...results].join('\n');

        return {
            content: [{ type: "text", text: report }],
            isError: failureCount > 0
        };

    } catch (error) {
        let errorMessage = 'An unknown error occurred';
        if (error instanceof Error) {
            errorMessage = error.message;
        }
        return { content: [{ type: "text", text: `Failed to batch update cards: ${errorMessage}` }], isError: true };
    }
  }
);

// Tool 14: Batch add cards to multiple different chapters
const chapterCardsSchema = z.object({
    chapterName: z.string().describe("The name of the chapter to add cards to. Will be created if it doesn't exist."),
    cards: z.array(cardSchema).min(1).describe("An array of card objects to add to this chapter.")
});

const batchAddCardsToChaptersSchema = z.object({
    deckId: z.string().describe("The ID of the deck to add the cards to."),
    chapterCards: z.array(chapterCardsSchema).min(1).describe("An array of objects, each containing a chapter name and cards to add to that chapter.")
});

server.tool(
  "batchAddCardsToChapters",
  batchAddCardsToChaptersSchema.shape,
  async ({ deckId, chapterCards }: z.infer<typeof batchAddCardsToChaptersSchema>) => {
    try {
        // Step 1: Get existing chapters and create a lookup map
        const chaptersResponse = await markjiApi.get(`/decks/${deckId}/chapters`);
        const existingChapters = chaptersResponse.data?.data?.chapters || [];
        const chapterMap = new Map<string, string>(); // name -> id
        
        existingChapters.forEach((ch: any) => {
            chapterMap.set(ch.name, ch.id);
        });

        const results: string[] = [];
        let totalSuccessCount = 0;
        let totalFailureCount = 0;
        const createdChapters: string[] = [];

        // Step 2: Process each chapter and its cards
        for (const chapterData of chapterCards) {
            const { chapterName, cards } = chapterData;
            
            try {
                // Step 2a: Find or create the chapter
                let chapterId: string;
                
                if (chapterMap.has(chapterName)) {
                    chapterId = chapterMap.get(chapterName)!;
                } else {
                    // Create new chapter
                    const createChapterResponse = await markjiApi.post(`/decks/${deckId}/chapters`, {
                        name: chapterName
                    });
                    
                    if (!createChapterResponse.data?.success) {
                        const errorMessage = createChapterResponse.data?.errors?.[0]?.message || 'Failed to create chapter';
                        results.push(`❌ Failed to create chapter "${chapterName}": ${errorMessage}`);
                        totalFailureCount += cards.length; // Count all cards as failed
                        continue;
                    }
                    
                    chapterId = createChapterResponse.data.data.chapter.id;
                    chapterMap.set(chapterName, chapterId);
                    createdChapters.push(chapterName);
                    results.push(`📁 Created new chapter: "${chapterName}" (ID: ${chapterId})`);
                }

                // Step 2b: Add all cards to this chapter concurrently
                const cardPromises = cards.map((card, index) => {
                    const cardContent = card.backContent ? `${card.content}\n---\n${card.backContent}` : card.content;
                    const payload = {
                        order: index + 1,
                        card: {
                            content: cardContent,
                            grammar_version: 3,
                        },
                    };
                    return markjiApi.post(`/decks/${deckId}/chapters/${chapterId}/cards`, payload);
                });

                const cardResults = await Promise.allSettled(cardPromises);
                let chapterSuccessCount = 0;
                let chapterFailureCount = 0;

                cardResults.forEach((result, index) => {
                    const cardContent = cards[index].content.substring(0, 20);
                    if (result.status === 'fulfilled') {
                        const response = result.value;
                        if (response.data?.success) {
                            chapterSuccessCount++;
                        } else {
                            const errorMessage = response.data?.errors?.[0]?.message || 'Unknown API error';
                            results.push(`  ❌ Failed to create card "${cardContent}..." in "${chapterName}": ${errorMessage}`);
                            chapterFailureCount++;
                        }
                    } else {
                        let errorMessage = 'An unknown error occurred';
                        if (axios.isAxiosError(result.reason)) {
                            errorMessage = result.reason.response?.data?.errors?.[0]?.message ||
                                `Status ${result.reason.response?.status}: ${result.reason.message}`;
                        } else if (result.reason instanceof Error) {
                            errorMessage = result.reason.message;
                        }
                        results.push(`  ❌ Failed to create card "${cardContent}..." in "${chapterName}": ${errorMessage}`);
                        chapterFailureCount++;
                    }
                });

                if (chapterSuccessCount > 0) {
                    results.push(`  ✅ Successfully added ${chapterSuccessCount} card(s) to "${chapterName}"`);
                }

                totalSuccessCount += chapterSuccessCount;
                totalFailureCount += chapterFailureCount;

            } catch (error) {
                let errorMessage = 'An unknown error occurred';
                if (error instanceof Error) {
                    errorMessage = error.message;
                }
                results.push(`❌ Failed to process chapter "${chapterName}": ${errorMessage}`);
                totalFailureCount += cards.length;
            }
        }

        // Step 3: Generate summary report
        const summary = `Batch add operation completed: ${totalSuccessCount} cards added successfully, ${totalFailureCount} failed.`;
        const createdChaptersSummary = createdChapters.length > 0 ?
            `Created ${createdChapters.length} new chapter(s): ${createdChapters.join(', ')}` :
            'No new chapters were created.';
        
        const report = [summary, createdChaptersSummary, '', ...results].join('\n');

        return {
            content: [{ type: "text", text: report }],
            isError: totalFailureCount > 0
        };

    } catch (error) {
        let errorMessage = 'An unknown error occurred';
        if (error instanceof Error) {
            errorMessage = error.message;
        }
        return { content: [{ type: "text", text: `Failed to batch add cards to chapters: ${errorMessage}` }], isError: true };
    }
  }
);

// Start the server
async function main() {
    console.error("Starting Markji MCP server...");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Markji MCP server running on stdio.");
}

main();
