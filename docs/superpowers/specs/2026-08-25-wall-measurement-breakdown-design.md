# Detalhamento de medições lineares e de parede

## Objetivo

Exibir no cartão de leitura do canvas uma lista das medições individuais que compõem o total, permitindo conferir cada linha ou polilinha sem abrir o painel de medições.

## Comportamento

- A lista aparece abaixo do total no cartão de leitura.
- Cada medição é exibida em uma linha numerada.
- Medições lineares exibem o comprimento individual.
- Medições de parede/polilinha exibem comprimento, altura e área calculada.
- A altura específica da forma tem prioridade sobre a altura padrão do acabamento.
- Quando não houver altura específica, usa-se a altura configurada no acabamento.
- O total existente permanece inalterado.
- A lista usa as unidades atuais do sistema.
- A lista só aparece quando houver medições lineares ou de parede no cartão ativo.

Exemplo:

```text
MEDIÇÕES
01  3,20 m × 2,40 m = 7,68 m²
02  4,60 m × 2,40 m = 11,04 m²
03  2,10 m linear
```

## Layout

- Usar uma seção compacta com o título `Medições`.
- Manter os números em fonte monoespaçada/tabular, seguindo os readouts existentes.
- Em telas estreitas, cada item pode quebrar em uma única linha vertical sem sobreposição.

## Implementação

- Reutilizar os dados de formas já usados para calcular o total do readout.
- Filtrar formas lineares e formas de parede/polilinha pertencentes à condição ativa e às folhas visíveis.
- Reutilizar os formatadores de comprimento, altura e área do canvas.
- Não criar uma nova fonte de dados nem alterar a persistência das formas.

## Validação

- Confirmar que linhas aparecem com comprimento.
- Confirmar que polylinhas de parede aparecem com comprimento, altura e área.
- Confirmar prioridade da altura específica da forma.
- Confirmar fallback para a altura do acabamento.
- Confirmar conversão entre imperial e métrico.
- Executar `npm run build` e os testes existentes.
