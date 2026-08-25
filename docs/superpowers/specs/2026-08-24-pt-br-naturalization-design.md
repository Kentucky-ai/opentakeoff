# Revisão do português brasileiro e adoção de unidades métricas

## Objetivo

Revisar todas as strings em português brasileiro do OpenTakeoff para que soem naturais no Brasil e reflitam com clareza o fluxo de medição de pisos, sem alterar o significado técnico da aplicação.

## Escopo

- Revisar os namespaces `canvas`, `panels`, `lib`, `guide` e `report` em `web/public/locales/pt-br/`.
- Padronizar termos de domínio na interface e nos textos de apoio:
  - `sheet` → “planta”;
  - `room` → “ambiente”;
  - `deduct` → “dedução”;
  - rastreamento de áreas/ambientes → “delimitar”;
  - linhas, marcadores e anotações → “desenhar” quando esse for o sentido.
- Corrigir concordância, regência, capitalização, pontuação, naturalidade e mensagens de erro.
- Usar unidades métricas na experiência pt-BR: área em `m²`, comprimento em `m`, altura/espessura em `mm` quando apropriado.
- Garantir que relatórios, CSV/XLSX, JSON e rótulos derivados respeitem o sistema de unidades escolhido, com o sistema métrico como padrão para pt-BR e opção imperial preservada.
- Atualizar documentação de usuário e referências de interface que ficarem desatualizadas.
- Preservar siglas e termos técnicos consolidados: RFI, PDF, CSV, JSON, XLSX, Drive, takeoff e demais identificadores de formato/produto.

## Fora do escopo

- Alterar a geometria armazenada ou a matemática interna de medição.
- Remover o suporte ao sistema imperial.
- Traduzir o backend, o MCP ou nomes técnicos de APIs que não são exibidos como texto de interface.
- Reescrever documentos históricos de planejamento apenas para fazer seus exemplos coincidirem com a tradução final.

## Validação

- Preservar todas as chaves e placeholders dos arquivos de tradução.
- Atualizar testes que validem rótulos ou unidades quando a mudança for intencional.
- Executar `npm run check` em `web/`.
- Conferir visualmente a interface em português, incluindo carregamento de plano, delimitação de ambiente, configurações de unidades e relatório.

## Critério de decisão linguística

Quando uma tradução literal soar estranha, priorizar o uso profissional corrente em português brasileiro e a clareza da ação. Em particular, “delimitar” será usado para definir os limites de uma área ou ambiente; “desenhar” ficará reservado a linhas, marcações e anotações.
