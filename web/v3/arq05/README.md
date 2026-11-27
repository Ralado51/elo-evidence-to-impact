# ARQ-05 Core — relatório, integração futura e decisões pendentes

Base: `b1e7a51f2c58b2d5228780ea7cb8c5a3ae863c62`. Branch local: `research/arq05-core`. Escopo: núcleo de pesquisa para dados sintéticos, sem ligação com as telas ou o UAT.

Fontes consultadas: [Arquitetura V2.2](https://docs.google.com/document/d/1luqspUGZzPaik-D717Jv0bTwoB93d5I8/edit), [Matriz de decisões do PO](https://docs.google.com/document/d/1n1qT4IDpd5apBz2YjtFNm9FVK1lDnw1Z/edit) e [Product Backlog](https://docs.google.com/spreadsheets/d/1FNlEiyL4H-QT0HbwkF_f0NaNxGTv5PeReatON2RONhU/edit), abas Componentes V2.2 e FIX x Histórias. A matriz consultada registra recomendações em aberto. O uso de sessionStorage no MVP foi autorizado pelo pedido. CMP-11/12 dão suporte a FIX-14/15 e às histórias US-031/034/037/038, sem encerrar itens do backlog.

## Implementação

- SessionController e máquina de estados: `idle → active → ended → reported`, para autorrelato. `reported` indica relato local; `pending`, `synced` e `conflict` separam transmissão de fase. Parada por dor, cansaço ou conclusão independe do transporte. O núcleo conserva a sessão pendente e não a sobrescreve. Não há dispensa, pausa/retomada, fluxo de produto ou regra de expiração implementada.
- StorageAdapter e RecoveryStore: interface assíncrona e um registro por organização/participante em sessionStorage. Comparação de revisão protege gravações concorrentes na mesma área de armazenamento. O registro guarda somente eventos sintéticos, cursor de confirmação e código/identificador de eventual conflito. Nenhum token nem credencial é recebido pelo armazenamento. A implementação não coordena abas distintas.
- EventOutbox: reutiliza o envelope, a cadeia e o hash do produto. Persiste a cópia dos eventos antes de qualquer tentativa de transmissão. Em cada leitura confere a cadeia, os identificadores e o conteúdo assinado. Um histórico completo e confirmado pode ser substituído localmente por uma nova sessão explícita. A exclusão ou a expiração de pendências não é oferecida.
- EventDispatcher: uma transmissão simultânea por instância; aceita somente confirmações explícitas `stored` ou `duplicate` pelo ID. Confirma apenas o prefixo contínuo e preserva o restante. Perda de resposta mantém os eventos para nova chamada explícita, sem regenerar os bytes. `HASH_CONFLICT` e `CHAIN_BROKEN` ficam registrados e suspendem transmissão. Nenhuma agenda automática de reenvio foi configurada.

## Testes bloqueantes

Executar da raiz: `node --test web/v3/arq05/core.test.mjs`. O processo retorna erro se uma asserção falhar. A suíte verifica reabertura dos componentes sobre o mesmo armazenamento, parada local, relato pendente, resposta perdida após gravação simulada, reenvio idêntico, recibos parciais, conflito, isolamento, concorrência no relato, confirmação concorrente com parada, falha de armazenamento e corrupção. Transporte e armazenamento são simulados. Ainda será necessário um teste no navegador com recarga real durante integração e um teste com o ledger real. A suíte não exige servidor nem dependências novas.

## Mapa de integração futura

1. Após a homologação do ARQ-04, criar o núcleo somente depois de autenticar o participante e resolver a organização e o principal autorizados. Instanciar `StorageAdapter → RecoveryStore → EventOutbox`, e ligar o `SessionController` ao mesmo outbox que o `EventDispatcher`. Vincular `client.postEventsBatch` à sessão autenticada em memória. Nunca alimentar o outbox com objetos de autenticação ou eventos brutos externos.
2. Projetar `restore()` na UI da jornada e usar a fase local para as ações de iniciar, parar e relatar. Apresentar separadamente o estado de envio. Uma recarga não autoriza retomar automaticamente uma atividade. O plano continua vindo da API para iniciar uma nova sessão. Parar uma sessão já aberta usa o escopo imutável da prescrição gravada na cadeia.
3. Manter as capacidades e a autorização do participante no cliente existente. Descartar resultados de UI após logout ou troca de principal via geração do contexto. Não presumir que a revogação de uma sessão cancela um envio já aceito pelo servidor.
4. Ligar transmissão e recuperação a ações ratificadas, sem alterar contratos. Exercitar recarga real, troca de contexto, confirmações perdidas, dupla submissão e mensagens acessíveis PT/EN antes de habilitar o fluxo. Não integrar este núcleo à Jornada do terapeuta ou ao Painel como parte desta entrega.

## Decisões pendentes

| Decisão | Tratamento no núcleo |
|---|---|
| D-ARQ5-01/02 | Recuperação local na aba no MVP autorizado. Não há recuperação entre dispositivos, após fechamento da aba ou armazenamento durável adicional. |
| D-ARQ5-03/04 | Pendente política de nova sessão com relato pendente, dispensa, logout e retenção. Núcleo preserva a cadeia pendente e não implementa descarte. |
| D-ARQ5-05/06 | Detecta conflito sem reconstruir. Ações de resolver/descartar, política de tentativas e gatilhos automáticos dependem de decisão. |
| D-ARQ5-07/08/09/10 | Fora deste núcleo: intenções do terapeuta, sessão órfã no servidor, FIX-16 e política de novo convite/renovação. |
| D-ARQ5-11 | Sem coordenação multiaba. Comparação de revisão apenas na mesma área de armazenamento. A integração não pode tratar isso como trava entre abas. |
| D-ARQ5-12/13/14 | Textos e acessibilidade, revisão de ameaças antes de dados reais e decisão de pausa/retomada permanecem pendentes. |
