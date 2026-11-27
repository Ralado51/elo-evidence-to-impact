# Elo Functional Intelligence v1.0.0-mvp

Release demonstrativa do Elo Functional Intelligence. Use exclusivamente dados sintéticos em uma instância local. O protótipo e a contagem por câmera não têm validação clínica.

## Instalação e inicialização

Requisitos: Git, Bash (Linux, macOS ou WSL), Python 3.11 ou superior, Node.js 24, curl e um navegador moderno. A câmera física requer autorização do navegador e do participante e funciona em contexto seguro, como localhost.

Confira o SHA-256 do bundle contra o arquivo `.sha256` distribuído junto dele. No Linux, rode `sha256sum -c elo-v1.0.0-mvp.bundle.sha256`. No PowerShell, use `Get-FileHash elo-v1.0.0-mvp.bundle -Algorithm SHA256` e compare o resultado completo.

```bash
git -c core.autocrlf=false clone -b release/v1.0.0-mvp elo-v1.0.0-mvp.bundle elo-mvp
cd elo-mvp
git config core.autocrlf false
git switch --detach v1.0.0-mvp
python3 -m venv .venv
.venv/bin/python -m pip install ./api
export PYTHON="$PWD/.venv/bin/python"
export TMPDIR="$(mktemp -d)"
bash scripts/demo_up.sh up
```

Preserve as quebras de linha LF ao extrair o repositório. A conversão para CRLF altera o SHA-256 dos arquivos JavaScript do MediaPipe. O script usa as portas locais 8080 (web) e 8000 (API). Para escolher outras, defina `PORT_WEB` e `PORT_API` antes de iniciar. Use um diretório temporário exclusivo para a demonstração. A inicialização recria os dados da instância demonstrativa.

## Roteiro de demonstração

1. Abra [a página inicial](http://127.0.0.1:8080/) e acesse a área do terapeuta. Use `terapeuta_demo` e `senha-sintetica-demo` apenas nessa instância local.
2. Cadastre um participante fictício, registre avaliação e meta, prescreva uma atividade e gere um convite. Abra-o em outro perfil do navegador e siga o plano do participante.
3. Conclua a prática e envie um autorrelato. Volte ao terapeuta para revisar a evidência e demonstrar a publicação do resumo e da evolução quando elegíveis. Registre um atendimento realizado externamente e confira a modalidade e a data clínica na linha do tempo.
4. Abra o [contador independente](http://127.0.0.1:8080/s2/contador.html) para demonstrar a interface sem câmera primeiro. Na jornada orientada, use simulação quando disponível. Para a câmera física, confirme o consentimento, enquadre a mão, siga a calibração apresentada e encerre a captura pelo controle da interface.
5. Encerre com `bash scripts/demo_up.sh down` no mesmo terminal. Os dados sintéticos e logs ficam no subdiretório `elo-demo` do diretório temporário escolhido.

## Funcionalidades disponíveis

- Terapeuta e participante com interface PT/EN, seleção de contexto, avaliações, metas, prescrições, convites, práticas, relatos e revisão humana de evidências.
- Resumos, evolução e linha do tempo publicados, com registro de atendimento externo. A explicação longitudinal, quando habilitada, referencia fatos publicados e sinaliza dados insuficientes.
- Contador de mão, simulação e captura experimental local com MediaPipe, consentimento, revogação e recuperação de eventos conforme os controles existentes. Organizar a Mesa integra a demonstração experimental.
- Rascunho assistido por provedor simulado e reprodução voluntária de instruções, quando o S4 está habilitado. O rascunho exige revisão humana e a alternativa textual permanece disponível. Para demonstrar o S4, acrescente `?s4=1` à página do terapeuta ou participante. Para o S3, defina `ELO_S3_EXPLANATIONS=1` antes de iniciar. A variante experimental da Mesa pode ser aberta com `/v3/participant.html?engine=c04` em um perfil já autenticado para o participante.

## Limitações conhecidas

- A calibração da câmera física ainda requer refinamento. Pode haver inconsistências na lateralidade detectada e na aceitação de ciclos. A validação de lateralidade permanece ativa.
- Há falhas conhecidas nos anúncios dinâmicos a leitores de tela (`live_region`). A demonstração não certifica acessibilidade.
- O S2 tem limitações experimentais documentadas no [relatório de implementação](docs/arch/S2_IMPLEMENTATION_REPORT.md). A validação automatizada com câmera simulada não substitui um ensaio com equipamento físico.
- Use o servidor somente em loopback. As credenciais são públicas por desenho e destinam-se à demonstração isolada. Não use dados reais ou serviços de produção.
- O [inventário do MediaPipe](web/s2/vendor/DEPENDENCIES_AND_LICENSES.md) documenta a licença Apache-2.0 do runtime e a atribuição do modelo pela ficha da família Hand Tracking. Confirme com o responsável pela publicação a cobertura de redistribuição do artefato exato do modelo.

[README original do protótipo](README.md)
