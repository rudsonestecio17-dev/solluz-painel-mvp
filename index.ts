// supabase/functions/copiloto-ia/index.ts
//
// Edge Function do Copiloto Solluz.
// Roda no servidor do Supabase (Deno) — a chave do Gemini e a service role key
// NUNCA ficam expostas no navegador do usuário.
//
// Fluxo:
// 1. Recebe { message, history } do frontend.
// 2. Manda pro Gemini junto com a lista de "ferramentas" disponíveis (tools).
// 3. Se o Gemini pedir pra chamar uma ferramenta (ex: criar_projeto), a function
//    executa a ação de verdade no Supabase e devolve o resultado pro Gemini.
// 4. Repete até o Gemini responder só com texto, e devolve essa resposta final
//    pro frontend.
 
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
 
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
// Esta é a service role key. Ela é injetada automaticamente pelo Supabase
// em toda Edge Function — você NÃO precisa cadastrá-la manualmente.
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
 
const GEMINI_MODEL = "gemini-3.7-flash";
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
 
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
 
// Cliente com privilégio total (service role) — só existe aqui no servidor.
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
 
// ---------- Definição das ferramentas que a IA pode usar ----------
const tools = [
  {
    functionDeclarations: [
      {
        name: "listar_projetos",
        description: "Lista os projetos cadastrados, opcionalmente filtrando por status.",
        parameters: {
          type: "object",
          properties: {
            status: {
              type: "string",
              description: "Filtrar por status: 'ativo', 'em andamento' ou 'concluido'. Deixe vazio para listar todos.",
            },
          },
        },
      },
      {
        name: "listar_clientes",
        description: "Lista todos os clientes cadastrados.",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "criar_cliente",
        description: "Cadastra um novo cliente.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Nome da empresa ou cliente." },
            document: { type: "string", description: "CNPJ ou CPF (opcional)." },
          },
          required: ["name"],
        },
      },
      {
        name: "criar_projeto",
        description: "Cria um novo projeto vinculado a um cliente já existente.",
        parameters: {
          type: "object",
          properties: {
            client_name: { type: "string", description: "Nome do cliente já cadastrado." },
            title: { type: "string", description: "Título do projeto." },
            description: { type: "string", description: "Descrição/escopo do projeto (opcional)." },
            status: { type: "string", description: "ativo, em andamento ou concluido. Padrão: ativo." },
          },
          required: ["client_name", "title"],
        },
      },
      {
        name: "atualizar_projeto",
        description: "Atualiza título, descrição e/ou status de um projeto existente, identificado pelo título atual.",
        parameters: {
          type: "object",
          properties: {
            project_title: { type: "string", description: "Título atual do projeto a editar." },
            novo_titulo: { type: "string", description: "Novo título (opcional)." },
            nova_descricao: { type: "string", description: "Nova descrição (opcional)." },
            novo_status: { type: "string", description: "Novo status: ativo, em andamento ou concluido (opcional)." },
          },
          required: ["project_title"],
        },
      },
      {
        name: "deletar_projeto",
        description: "Exclui um projeto pelo título. Use com cuidado, a ação é irreversível.",
        parameters: {
          type: "object",
          properties: {
            project_title: { type: "string", description: "Título do projeto a excluir." },
          },
          required: ["project_title"],
        },
      },
      {
        name: "listar_pecas_projeto",
        description: "Lista as peças/arquivos cadastrados de um projeto específico.",
        parameters: {
          type: "object",
          properties: {
            project_title: { type: "string", description: "Título do projeto." },
          },
          required: ["project_title"],
        },
      },
    ],
  },
];
 
// ---------- Implementação real de cada ferramenta ----------
async function executarFuncao(name: string, args: Record<string, unknown>) {
  switch (name) {
    case "listar_projetos": {
      let query = supabaseAdmin.from("projects").select("id, title, description, status, clients(name)");
      if (args.status) query = query.eq("status", args.status as string);
      const { data, error } = await query;
      if (error) return { error: error.message };
      return { projetos: data };
    }
 
    case "listar_clientes": {
      const { data, error } = await supabaseAdmin.from("clients").select("id, name, document");
      if (error) return { error: error.message };
      return { clientes: data };
    }
 
    case "criar_cliente": {
      const { data, error } = await supabaseAdmin
        .from("clients")
        .insert([{ name: args.name, document: args.document ?? null }])
        .select()
        .single();
      if (error) return { error: error.message };
      return { sucesso: true, cliente: data };
    }
 
    case "criar_projeto": {
      const { data: cliente, error: clienteErr } = await supabaseAdmin
        .from("clients")
        .select("id, name")
        .ilike("name", `%${args.client_name}%`)
        .limit(1)
        .maybeSingle();
      if (clienteErr) return { error: clienteErr.message };
      if (!cliente) return { error: `Cliente "${args.client_name}" não encontrado. Cadastre o cliente primeiro.` };
 
      const { data, error } = await supabaseAdmin
        .from("projects")
        .insert([{
          client_id: cliente.id,
          title: args.title,
          description: args.description ?? null,
          status: args.status ?? "ativo",
        }])
        .select()
        .single();
      if (error) return { error: error.message };
      return { sucesso: true, projeto: data };
    }
 
    case "atualizar_projeto": {
      const { data: projeto, error: findErr } = await supabaseAdmin
        .from("projects")
        .select("id")
        .ilike("title", `%${args.project_title}%`)
        .limit(1)
        .maybeSingle();
      if (findErr) return { error: findErr.message };
      if (!projeto) return { error: `Projeto "${args.project_title}" não encontrado.` };
 
      const updates: Record<string, unknown> = {};
      if (args.novo_titulo) updates.title = args.novo_titulo;
      if (args.nova_descricao) updates.description = args.nova_descricao;
      if (args.novo_status) updates.status = args.novo_status;
 
      const { data, error } = await supabaseAdmin
        .from("projects")
        .update(updates)
        .eq("id", projeto.id)
        .select()
        .single();
      if (error) return { error: error.message };
      return { sucesso: true, projeto: data };
    }
 
    case "deletar_projeto": {
      const { data: projeto, error: findErr } = await supabaseAdmin
        .from("projects")
        .select("id, title")
        .ilike("title", `%${args.project_title}%`)
        .limit(1)
        .maybeSingle();
      if (findErr) return { error: findErr.message };
      if (!projeto) return { error: `Projeto "${args.project_title}" não encontrado.` };
 
      const { error } = await supabaseAdmin.from("projects").delete().eq("id", projeto.id);
      if (error) return { error: error.message };
      return { sucesso: true, excluido: projeto.title };
    }
 
    case "listar_pecas_projeto": {
      const { data: projeto, error: findErr } = await supabaseAdmin
        .from("projects")
        .select("id")
        .ilike("title", `%${args.project_title}%`)
        .limit(1)
        .maybeSingle();
      if (findErr) return { error: findErr.message };
      if (!projeto) return { error: `Projeto "${args.project_title}" não encontrado.` };
 
      const { data, error } = await supabaseAdmin
        .from("content_pieces")
        .select("title, platform, media_url, scheduled_date")
        .eq("project_id", projeto.id);
      if (error) return { error: error.message };
      return { pecas: data };
    }
 
    default:
      return { error: `Ferramenta desconhecida: ${name}` };
  }
}
 
// ---------- Loop de conversa com o Gemini ----------
async function chamarGemini(contents: unknown[]) {
  const resp = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      tools,
      systemInstruction: {
        parts: [{
          text:
            "Você é o Copiloto Solluz, assistente de gestão de produção de vídeo e marketing. " +
            "Você tem acesso direto ao banco de dados da empresa através de ferramentas (functions). " +
            "Sempre que o usuário pedir para consultar, criar, editar ou excluir clientes/projetos/peças, " +
            "use a ferramenta apropriada em vez de apenas responder em texto. " +
            "Confirme ações destrutivas (excluir) resumindo o que foi feito. Responda sempre em português, de forma direta e objetiva.",
        }],
      },
    }),
  });
 
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Erro Gemini (${resp.status}): ${errText}`);
  }
  return await resp.json();
}
 
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
 
  try {
    const { message, history } = await req.json();
 
    // Monta o histórico no formato do Gemini (role: "user" | "model")
    const contents: unknown[] = (history ?? []).map(
      (h: { role: string; text: string }) => ({
        role: h.role === "assistant" ? "model" : "user",
        parts: [{ text: h.text }],
      }),
    );
    contents.push({ role: "user", parts: [{ text: message }] });
 
    let respostaFinal = "";
    const MAX_TURNS = 5;
 
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const data = await chamarGemini(contents);
      const candidate = data?.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
 
      const functionCallPart = parts.find((p: any) => p.functionCall);
 
      if (functionCallPart) {
        // O Gemini pediu pra chamar uma ferramenta: executa de verdade no Supabase.
        const { name, args } = functionCallPart.functionCall;
        const resultado = await executarFuncao(name, args ?? {});
 
        // Adiciona a chamada e o resultado na conversa e continua o loop
        contents.push({ role: "model", parts: [{ functionCall: { name, args } }] });
        contents.push({
          role: "function",
          parts: [{ functionResponse: { name, response: resultado } }],
        });
        continue;
      }
 
      // Resposta final em texto
      respostaFinal = parts.map((p: any) => p.text ?? "").join("").trim() ||
        "Não consegui gerar uma resposta.";
      break;
    }
 
    return new Response(JSON.stringify({ reply: respostaFinal }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});