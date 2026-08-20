# 对战平台服务器生产镜像（含 Linux 版 eleeye 象棋引擎）
# 构建阶段：编译 Linux 版 eleeye（Windows 版 eleeye.exe 无法在 Linux 容器运行）
FROM node:20-alpine AS engine-build
RUN apk add --no-cache build-base
WORKDIR /tmp
RUN wget -qO eleeye.zip https://codeload.github.com/xqbase/eleeye/zip/refs/heads/master \
 && unzip -q eleeye.zip
WORKDIR /tmp/eleeye-master/eleeye
RUN g++ -DNDEBUG -O4 -Wall -o /out/eleeye \
    ../base/pipe.cpp ucci.cpp pregen.cpp position.cpp genmoves.cpp hash.cpp \
    book.cpp movesort.cpp preeval.cpp evaluate.cpp search.cpp eleeye.cpp

# 运行阶段
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY --from=engine-build /out/eleeye ./engines/eleeye

ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "src/index.js"]
