import { readdir, readFile, stat } from "fs/promises";
import { Configuration, OpenAIApi } from "openai";
import { join } from "path";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { inspect } from "util";
import { MarkdownTextSplitter } from "langchain/text_splitter";
import { createHash } from "crypto";

dotenv.config({
  path: ".env",
});

const processMdxForSearch = async (
  contents: string
): Promise<{ sections: any; checksum: any }> => {
  const splitter = new MarkdownTextSplitter();
  const checksum = createHash("sha256").update(contents).digest("base64");
  const output = await splitter.createDocuments([contents]);
  return {
    checksum,
    sections: output,
  };
};

const supabase = createClient(
  `https://${process.env.PROJECT_ID}.supabase.co`,
  process.env.NEXT_ANON_KEY as string
);

async function walk(dir: string): Promise<string[]> {
  const immediateFiles = await readdir(dir);

  const recursiveFiles = await Promise.all(
    immediateFiles.map(async (file) => {
      const filePath = join(dir, file);
      const stats = await stat(filePath);
      if (stats.isDirectory()) {
        return walk(filePath);
      } else if (stats.isFile()) {
        return [filePath];
      } else {
        return [];
      }
    })
  );

  const flattenedFiles = recursiveFiles.reduce(
    (all, folderContents) => all.concat(folderContents),
    []
  );

  return flattenedFiles;
}

async function generateEmbeddings() {
  const markdownFiles = (await walk("data")).filter((fileName) =>
    /\.md?$/.test(fileName)
  );

  console.log(`Discovered ${markdownFiles.length} pages`);
  console.log("Checking which pages are new or have changed");
  for (const markdownFile of markdownFiles) {
    const path = markdownFile.replace(/^data/, "").replace(/\.mdx?$/, "");
    try {
      const contents = await readFile(markdownFile, "utf8");
      const { checksum, sections } = await processMdxForSearch(contents);
      // console.log({ sections });
      // console.log({ path });

      // Create/update page record. Intentionally clear checksum until we
      // have successfully generated all page sections.
      const { error: upsertPageError, data: page } = await supabase
        .from("page")
        .upsert({ checksum: null, path }, { onConflict: "path" })
        .select()
        .limit(1)
        .single();
      console.log(
        `Adding ${sections.length} page sections (with embeddings) for '${path}'`
      );
      // console.log({ sections });
      for (const section of sections) {
        // OpenAI recommends replacing newlines with spaces for best results (specific to embeddings)
        const input = section.pageContent.replace(/\n/g, " ");
        // console.log(input);

        try {
          const configuration = new Configuration({
            apiKey: process.env.OPENAI_KEY,
          });
          const openai = new OpenAIApi(configuration);

          const embeddingResponse = await openai.createEmbedding({
            model: "text-embedding-ada-002",
            input,
          });

          if (embeddingResponse.status !== 200) {
            throw new Error(inspect(embeddingResponse.data, false, 2));
          }

          const [responseData] = embeddingResponse.data.data;

          const { error: insertPageSectionError, data: pageSection } =
            await supabase
              .from("page_section")
              .insert({
                page_id: page?.id,
                content: section.pageContent,
                token_count: embeddingResponse.data.usage.total_tokens,
                embedding: responseData.embedding,
              })
              .select()
              .limit(1)
              .single();

          console.log({ pageSection });

          if (insertPageSectionError) {
            throw insertPageSectionError;
          }
        } catch (err) {
          // TODO: decide how to better handle failed embeddings
          console.error(
            `Failed to generate embeddings for '${path}' page section starting with '${input.slice(
              0,
              40
            )}...'`
          );
          console.log({ err });
          throw err;
        }
      }

      //Set page checksum so that we know this page was stored successfully
      const { error: updatePageError } = await supabase
        .from("page")
        .update({ checksum })
        .filter("id", "eq", page?.id);

      if (updatePageError) {
        throw updatePageError;
      }
    } catch (err) {
      console.error(
        `Page '${path}' or one/multiple of its page sections failed to store properly. Page has been marked with null checksum to indicate that it needs to be re-generated.`
      );
    }
  }
  console.log("Embedding generation complete");
}

async function main() {
  await generateEmbeddings();
}

main().catch((err) => console.error(err));
