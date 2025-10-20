// tasks.js: 課題データを定義します。
// 必要に応じてこのファイルを編集して課題やヒントを更新できます。

const tasksData = [
  {
    id: "task1",
    title: "2つの数字の合計",
    description: "2つの数字を入力してその合計を表示するプログラムを書きます。\n入力はそれぞれ別々の行から受け取ってください。",
    hint: "input() で文字列を読み取り、int() に渡して整数に変換します。変数に代入したら + で足し算し、print() で表示しましょう。",
    answer: "a = int(input())\nb = int(input())\nprint(a + b)"
  },
  {
    id: "task2",
    title: "九九表の表示",
    description: "掛け算の九九表を1段から9段まで表示するプログラムを書きます。各行に1段分の結果を空白区切りで出力してください。",
    hint: "外側の for で1から9までの段を、内側の for で掛ける数を回します。print() に end=\" \" を指定すると改行せずに半角スペースで区切って出力できます。",
    answer: "for i in range(1, 10):\n    for j in range(1, 10):\n        print(i * j, end=\" \")\n    print()"
  }
];

// ブラウザのグローバルスコープに tasksData を公開する
if (typeof window !== "undefined") {
  window.tasksData = tasksData;
}